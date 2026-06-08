require('dotenv').config();
process.on('uncaughtException', err => { console.error('UNCAUGHT EXCEPTION:', err.message, err.stack); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('UNHANDLED REJECTION:', reason); });
const express = require('express');
const https = require('https');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1); // Required for Railway — enables X-Forwarded-For
const PORT = process.env.PORT || 3000;

// ── MUSCLEWIKI EXERCISE CACHE ─────────────────────────
// Fetched once at startup, cached in memory
let mwExerciseCache = null;
let mwExerciseCacheTime = 0;
const MW_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ── YOUTUBE VIDEO LOOKUP ─────────────────────────────────
// Replaces MuscleWiki — YouTube Data API v3, 10k free calls/day
// Each exercise cached in Supabase permanently after first lookup

const _ytCache = new Map(); // in-memory: exercise name → {videoId, title}

async function getYouTubeVideoId(exerciseName) {
  const lower = exerciseName.toLowerCase().trim();

  // 1. In-memory cache
  if (_ytCache.has(lower)) return _ytCache.get(lower);

  // 2. Supabase cache
  try {
    const { data } = await supabase
      .from('exercise_video_cache')
      .select('video_id, video_title')
      .eq('exercise_name', lower)
      .maybeSingle();
    if (data?.video_id) {
      _ytCache.set(lower, { videoId: data.video_id, title: data.video_title });
      return { videoId: data.video_id, title: data.video_title };
    }
  } catch(e) { /* table may not exist */ }

  // 3. YouTube Data API search
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  try {
    // Search for short form tutorials — under 4 minutes, prioritise quick how-to channels
    const query = encodeURIComponent(exerciseName + ' how to proper form');
    // videoDuration=short targets videos under 4 minutes
    const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&q=' + query
      + '&type=video&maxResults=5&videoDuration=short&relevanceLanguage=en'
      + '&key=' + apiKey;

    const r = await fetch(url);
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn('YouTube search failed:', r.status, errText.slice(0, 200));
      return null;
    }
    const data = await r.json();
    const items = data.items || [];
    if (!items.length) return null;

    // Prefer channels known for short, clean form demonstrations
    const preferred = [
      'Jeff Nippard','Alan Thrall','Squat University','Austin Current',
      'Starting Strength','Athlean-X','Jeremy Ethier','Renaissance Periodization',
      'PictureFit','Buff Dudes','Scott Herman Fitness','Bodybuilding.com',
      'FitnessFAQs','Dr. Mike Israetel'
    ];

    // Score results — prefer short videos from trusted channels
    let best = items[0];
    for (const item of items) {
      const channel = item.snippet?.channelTitle || '';
      const title = item.snippet?.title?.toLowerCase() || '';
      // Skip obviously long videos (playlists, full workouts)
      if (title.includes('full workout') || title.includes('30 min') || title.includes('hour')) continue;
      if (preferred.some(p => channel.toLowerCase().includes(p.toLowerCase()))) {
        best = item;
        break;
      }
    }

    const result = {
      videoId: best.id.videoId,
      title: best.snippet?.title || exerciseName,
      channel: best.snippet?.channelTitle || '',
    };

    // Cache in memory
    _ytCache.set(lower, result);

    // Cache in Supabase permanently — fire and forget
    supabase.from('exercise_video_cache').upsert({
      exercise_name: lower,
      video_id: result.videoId,
      video_title: result.title,
      channel: result.channel,
      updated_at: new Date().toISOString()
    }, { onConflict: 'exercise_name' }).then(() => {}).catch(() => {});

    console.log('YouTube found for', exerciseName, ':', result.videoId, '|', result.title);
    return result;
  } catch(e) {
    console.warn('YouTube lookup error:', e.message);
    return null;
  }
}

// Keep getMuscleWikiExercises as a stub — still used by plan prompt injection
async function getMuscleWikiExercises() {
  return mwExerciseCache || [];
}


// Build exercise name lookup map: lowercase name -> exact name
function buildExerciseLookup(exercises) {
  const map = {};
  for (const ex of exercises) {
    map[ex.name.toLowerCase().trim()] = ex.name;
  }
  return map;
}

// Find closest MuscleWiki exercise name for a given name
function findMuscleWikiName(name, exercises) {
  if (!exercises || !name) return null;
  const nameLower = name.toLowerCase().trim();

  // 0. Manual mapping table
  if (EXERCISE_NAME_MAP[nameLower]) return EXERCISE_NAME_MAP[nameLower];

  // 1. Exact match
  const exact = exercises.find(e => e.name.toLowerCase() === nameLower);
  if (exact) return exact.name;

  // 2. All meaningful words from AI name must appear in MuscleWiki name
  const words = nameLower.split(' ').filter(w => w.length >= 3);
  if (words.length < 2) return null; // too vague, don't guess

  const allMatch = exercises.filter(e => {
    const en = e.name.toLowerCase();
    return words.every(w => en.includes(w));
  });

  if (allMatch.length === 1) return allMatch[0].name;
  if (allMatch.length > 1) {
    // Prefer shortest name (avoids "Dumbbell Full Lateral Raise" over "Dumbbell Lateral Raise")
    return allMatch.sort((a, b) => a.name.length - b.name.length)[0].name;
  }

  // 3. Try without equipment prefix
  const stripped = nameLower.replace(/^(barbell|dumbbell|cable|machine|kettlebell|ez bar|ez-bar|bodyweight|bw|db|bb|kb)\s+/i, '');
  if (stripped !== nameLower) {
    const strippedWords = stripped.split(' ').filter(w => w.length >= 3);
    const strippedMatch = exercises.filter(e => {
      const en = e.name.toLowerCase();
      return strippedWords.every(w => en.includes(w));
    });
    if (strippedMatch.length >= 1) {
      return strippedMatch.sort((a, b) => a.name.length - b.name.length)[0].name;
    }
  }

  return null; // No confident match — don't remap
}

// Async version that also tries AI normalisation
async function findMuscleWikiNameAsync(name, exercises) {
  const sync = findMuscleWikiName(name, exercises);
  if (sync) return sync;
  return await normaliseExerciseNameWithAI(name, exercises);
}


// ── EXERCISE NAME MANUAL MAPPING TABLE ───────────────────
// Common AI-generated names → exact MuscleWiki names
// Add to this as you spot mismatches
const EXERCISE_NAME_MAP = {
  // Legs
  'leg curl': 'Dumbbell Leg Curl',
  'leg curls': 'Dumbbell Leg Curl',
  'hamstring curl': 'Dumbbell Leg Curl',
  'lying leg curl': 'Dumbbell Leg Curl',
  'machine leg curl': 'Machine Leg Curl',
  'seated leg curl': 'Machine Seated Leg Curl',
  'leg press': 'Machine Leg Press',
  'leg extension': 'Machine Leg Extension',
  'leg extensions': 'Machine Leg Extension',
  'calf raise': 'Dumbbell Calf Raise',
  'calf raises': 'Dumbbell Calf Raise',
  'standing calf raise': 'Dumbbell Calf Raise',
  'seated calf raise': 'Machine Seated Calf Raise',
  'bulgarian split squat': 'Dumbbell Bulgarian Split Squat',
  'split squat': 'Dumbbell Bulgarian Split Squat',
  'goblet squat': 'Dumbbell Goblet Squat',
  'hack squat': 'Machine Hack Squat',
  'rdl': 'Barbell Romanian Deadlift',
  'romanian deadlift': 'Barbell Romanian Deadlift',
  'dumbbell rdl': 'Dumbbell Romanian Deadlift',
  'stiff leg deadlift': 'Barbell Romanian Deadlift',
  'sumo deadlift': 'Barbell Sumo Deadlift',
  // Chest
  'bench press': 'Barbell Bench Press',
  'incline bench press': 'Barbell Incline Bench Press',
  'decline bench press': 'Barbell Decline Bench Press',
  'dumbbell press': 'Dumbbell Bench Press',
  'incline dumbbell press': 'Dumbbell Incline Bench Press',
  'chest fly': 'Dumbbell Fly',
  'cable fly': 'Cable Fly',
  'cable crossover': 'Cable Fly',
  'push up': 'Bodyweight Push-Up',
  'push ups': 'Bodyweight Push-Up',
  'dip': 'Bodyweight Dip',
  'dips': 'Bodyweight Dip',
  'chest dip': 'Bodyweight Dip',
  // Back
  'pull up': 'Bodyweight Pull-Up',
  'pull ups': 'Bodyweight Pull-Up',
  'chin up': 'Bodyweight Chin-Up',
  'chin ups': 'Bodyweight Chin-Up',
  'lat pulldown': 'Cable Lat Pulldown',
  'pull down': 'Cable Lat Pulldown',
  'seated row': 'Cable Seated Row',
  'cable row': 'Cable Seated Row',
  'bent over row': 'Barbell Bent-Over Row',
  'barbell row': 'Barbell Bent-Over Row',
  'dumbbell row': 'Dumbbell Single-Arm Row',
  'single arm row': 'Dumbbell Single-Arm Row',
  'one arm row': 'Dumbbell Single-Arm Row',
  't-bar row': 'Barbell T-Bar Row',
  'face pull': 'Cable Face Pull',
  'face pulls': 'Cable Face Pull',
  'deadlift': 'Barbell Deadlift',
  // Shoulders
  'overhead press': 'Barbell Overhead Press',
  'shoulder press': 'Dumbbell Shoulder Press',
  'military press': 'Barbell Overhead Press',
  'lateral raise': 'Dumbbell Lateral Raise',
  'lateral raises': 'Dumbbell Lateral Raise',
  'side lateral raise': 'Dumbbell Lateral Raise',
  'front raise': 'Dumbbell Front Raise',
  'front raises': 'Dumbbell Front Raise',
  'rear delt fly': 'Dumbbell Rear Delt Fly',
  'reverse fly': 'Dumbbell Rear Delt Fly',
  'upright row': 'Barbell Upright Row',
  'arnold press': 'Dumbbell Arnold Press',
  // Arms
  'bicep curl': 'Dumbbell Bicep Curl',
  'bicep curls': 'Dumbbell Bicep Curl',
  'curl': 'Dumbbell Bicep Curl',
  'barbell curl': 'Barbell Bicep Curl',
  'hammer curl': 'Dumbbell Hammer Curl',
  'hammer curls': 'Dumbbell Hammer Curl',
  'preacher curl': 'Barbell Preacher Curl',
  'concentration curl': 'Dumbbell Concentration Curl',
  'tricep pushdown': 'Cable Tricep Pushdown',
  'tricep extension': 'Dumbbell Tricep Extension',
  'overhead tricep extension': 'Dumbbell Overhead Tricep Extension',
  'skull crusher': 'Barbell Skull Crusher',
  'skull crushers': 'Barbell Skull Crusher',
  'close grip bench press': 'Barbell Close Grip Bench Press',
  // Core
  'plank': 'Bodyweight Plank',
  'crunch': 'Bodyweight Crunch',
  'crunches': 'Bodyweight Crunch',
  'sit up': 'Bodyweight Sit-Up',
  'sit ups': 'Bodyweight Sit-Up',
  'leg raise': 'Bodyweight Leg Raise',
  'leg raises': 'Bodyweight Leg Raise',
  'russian twist': 'Bodyweight Russian Twist',
  'ab rollout': 'Ab Wheel Rollout',
};

// AI-assisted normalisation cache — maps unknown names to MuscleWiki names
const aiExerciseNameCache = new Map();

async function normaliseExerciseNameWithAI(name, exercises) {
  if (!exercises || !name) return null;

  // Check AI cache first
  const cached = aiExerciseNameCache.get(name.toLowerCase().trim());
  if (cached !== undefined) return cached; // cached null = confirmed no match

  try {
    const exerciseList = exercises.slice(0, 500).map(e => e.name).join(', ');
    // Use global anthropic instance — don't re-instantiate
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: 'From this exercise database list, find the EXACT name that matches "' + name + '". Reply with ONLY the exact name from the list, or "NONE" if no match exists. List: ' + exerciseList
      }]
    });

    const result = msg.content[0].text.trim();
    const matched = result === 'NONE' ? null : (exercises.find(e => e.name === result)?.name || null);
    aiExerciseNameCache.set(name.toLowerCase().trim(), matched);
    return matched;
  } catch(e) {
    console.error('AI exercise normalisation error:', e.message);
    return null;
  }
}

// ── MANUAL EXERCISE NAME MAP ─────────────────────────
const MANUAL_EXERCISE_MAP = {
  'leg curl':'Dumbbell Leg Curl','leg curls':'Dumbbell Leg Curl',
  'lying leg curl':'Machine Lying Leg Curl','seated leg curl':'Machine Seated Leg Curl',
  'hamstring curl':'Dumbbell Leg Curl','hamstring curls':'Dumbbell Leg Curl',
  'nordic curl':'Bodyweight Nordic Hamstring Curl',
  'romanian deadlift':'Barbell Romanian Deadlift','rdl':'Barbell Romanian Deadlift',
  'dumbbell rdl':'Dumbbell Romanian Deadlift','dumbbell romanian deadlift':'Dumbbell Romanian Deadlift',
  'single leg rdl':'Dumbbell Single Leg Romanian Deadlift',
  'lateral raise':'Dumbbell Lateral Raise','lateral raises':'Dumbbell Lateral Raise',
  'side lateral raise':'Dumbbell Lateral Raise','side raise':'Dumbbell Lateral Raise',
  'cable lateral raise':'Cable Lateral Raise','machine lateral raise':'Machine Lateral Raise',
  'bench press':'Barbell Bench Press','flat bench press':'Barbell Bench Press',
  'incline press':'Barbell Incline Bench Press','incline bench press':'Barbell Incline Bench Press',
  'decline bench press':'Barbell Decline Bench Press',
  'dumbbell press':'Dumbbell Bench Press','dumbbell bench press':'Dumbbell Bench Press',
  'chest fly':'Dumbbell Fly','cable fly':'Cable Fly','pec deck':'Machine Fly',
  'dumbbell flyes':'Dumbbell Fly','dumbbell fly':'Dumbbell Fly','dumbbell flies':'Dumbbell Fly',
  'incline dumbbell flyes':'Dumbbell Incline Fly','incline fly':'Dumbbell Incline Fly','incline flies':'Dumbbell Incline Fly',
  'pull up':'Bodyweight Pull Up','pull ups':'Bodyweight Pull Up','pullup':'Bodyweight Pull Up','bodyweight pull up':'Bodyweight Pull Up','bodyweight pullup':'Bodyweight Pull Up',
  'chin up':'Bodyweight Chin Up','chin ups':'Bodyweight Chin Up',
  'lat pulldown':'Cable Lat Pulldown','cable pulldown':'Cable Lat Pulldown',
  'seated row':'Cable Seated Row','cable row':'Cable Seated Row',
  'bent over row':'Barbell Bent Over Row','barbell row':'Barbell Bent Over Row',
  'dumbbell row':'Dumbbell Bent Over Row','one arm row':'Dumbbell Single Arm Row',
  'single arm row':'Dumbbell Single Arm Row','t-bar row':'Barbell T-Bar Row',
  'face pull':'Cable Face Pull','face pulls':'Cable Face Pull',
  'overhead press':'Barbell Overhead Press','shoulder press':'Barbell Overhead Press',
  'military press':'Barbell Overhead Press','ohp':'Barbell Overhead Press',
  'dumbbell shoulder press':'Dumbbell Shoulder Press','arnold press':'Dumbbell Arnold Press',
  'front raise':'Dumbbell Front Raise','rear delt fly':'Dumbbell Rear Delt Fly',
  'rear delt raise':'Dumbbell Rear Delt Fly','rear lateral raise':'Dumbbell Rear Delt Fly',
  'bicep curl':'Dumbbell Bicep Curl','bicep curls':'Dumbbell Bicep Curl',
  'barbell curl':'Barbell Curl','ez bar curl':'EZ Bar Curl','ez curl':'EZ Bar Curl',
  'hammer curl':'Dumbbell Hammer Curl','hammer curls':'Dumbbell Hammer Curl',
  'preacher curl':'Barbell Preacher Curl','concentration curl':'Dumbbell Concentration Curl',
  'tricep pushdown':'Cable Tricep Pushdown','cable pushdown':'Cable Tricep Pushdown',
  'tricep dip':'Bodyweight Tricep Dip','dips':'Bodyweight Tricep Dip','dip':'Bodyweight Tricep Dip',
  'skull crusher':'EZ Bar Skull Crusher','skull crushers':'EZ Bar Skull Crusher',
  'overhead tricep extension':'Dumbbell Overhead Tricep Extension',
  'tricep extension':'Cable Tricep Extension','tricep extensions':'Cable Tricep Extension',
  'squat':'Barbell Squat','back squat':'Barbell Squat','front squat':'Barbell Front Squat',
  'goblet squat':'Dumbbell Goblet Squat','bulgarian split squat':'Dumbbell Bulgarian Split Squat',
  'split squat':'Dumbbell Bulgarian Split Squat','lunge':'Dumbbell Lunge','lunges':'Dumbbell Lunge',
  'walking lunge':'Dumbbell Walking Lunge','leg press':'Machine Leg Press',
  'leg extension':'Machine Leg Extension','leg extensions':'Machine Leg Extension',
  'calf raise':'Machine Calf Raise','calf raises':'Machine Calf Raise',
  'standing calf raise':'Machine Calf Raise','seated calf raise':'Machine Seated Calf Raise',
  'hip thrust':'Barbell Hip Thrust','glute bridge':'Bodyweight Glute Bridge',
  'deadlift':'Barbell Deadlift','conventional deadlift':'Barbell Deadlift',
  'sumo deadlift':'Barbell Sumo Deadlift','trap bar deadlift':'Trap Bar Deadlift',
  'plank':'Bodyweight Plank','crunch':'Bodyweight Crunch','crunches':'Bodyweight Crunch',
  'sit up':'Bodyweight Sit Up','sit ups':'Bodyweight Sit Up',
  'leg raise':'Bodyweight Leg Raise','leg raises':'Bodyweight Leg Raise',
  'russian twist':'Bodyweight Russian Twist','cable crunch':'Cable Crunch',
  'ab wheel':'Ab Wheel Rollout','ab wheel rollout':'Ab Wheel Rollout',
  'push up':'Bodyweight Push Up','push ups':'Bodyweight Push Up','pushup':'Bodyweight Push Up',
  'dumbbell fly':'Dumbbell Fly','incline dumbbell fly':'Dumbbell Incline Fly',
  'cable crossover':'Cable Crossover','upright row':'Barbell Upright Row',
  'shrug':'Barbell Shrug','dumbbell shrug':'Dumbbell Shrug','barbell shrug':'Barbell Shrug',
  'good morning':'Barbell Good Morning','back extension':'Machine Back Extension',
  'hyperextension':'Machine Back Extension','reverse fly':'Dumbbell Rear Delt Fly',
  'incline dumbbell curl':'Dumbbell Incline Curl','cable curl':'Cable Bicep Curl',
  'rope pushdown':'Cable Rope Tricep Pushdown','overhead cable extension':'Cable Overhead Tricep Extension',
  // Additional mappings from test failures + console observations
  'cable tricep pushdown':'Cable Rope Tricep Pushdown',
  'tricep rope pushdown':'Cable Rope Tricep Pushdown',
  'cable pushdown':'Cable Rope Tricep Pushdown',
  'cable tricep pushdowns':'Cable Rope Tricep Pushdown',
  // Dips
  'dips':'Bodyweight Dip','dip':'Bodyweight Dip',
  'bodyweight dips':'Bodyweight Dip','tricep dips':'Bodyweight Dip',
  'chest dips':'Bodyweight Dip','weighted dips':'Weighted Dip',
  // Cable lateral raises
  'cable lateral raises':'Cable Lateral Raise',
  'cable lateral raise':'Cable Lateral Raise',
  // Shoulder press
  'dumbbell shoulder press':'Dumbbell Shoulder Press',
  'db shoulder press':'Dumbbell Shoulder Press',
  'seated dumbbell shoulder press':'Dumbbell Shoulder Press',
  // Flyes plural
  'dumbbell flyes':'Dumbbell Fly',
  'dumbbell flies':'Dumbbell Fly',
  'cable flyes':'Cable Fly','cable flies':'Cable Fly',
  // Common plurals the AI adds
  'lateral raises':'Dumbbell Lateral Raise',
  'hammer curls':'Dumbbell Hammer Curl',
  'bicep curls':'Dumbbell Bicep Curl',
  'tricep extensions':'Cable Tricep Extension',
  'leg curls':'Machine Lying Leg Curl',
  'leg extensions':'Machine Leg Extension',
  'calf raises':'Machine Calf Raise',
  'hip thrusts':'Barbell Hip Thrust',
  'lunges':'Dumbbell Lunge',
  'pull ups':'Bodyweight Pull Up',
  'chin ups':'Bodyweight Chin Up',
  'push ups':'Bodyweight Push Up',
  'sit ups':'Bodyweight Sit Up',
  // Shoulder press variants
  'dumbbell shoulder press':'Dumbbell Shoulder Press',
  'seated dumbbell press':'Dumbbell Shoulder Press',
  'seated dumbbell shoulder press':'Dumbbell Shoulder Press',
  'db shoulder press':'Dumbbell Shoulder Press',
  // Fly variants
  'dumbbell flyes':'Dumbbell Fly',
  'dumbbell fly':'Dumbbell Fly',
  'dumbbell flies':'Dumbbell Fly',
  'flat dumbbell fly':'Dumbbell Fly',
  'flat dumbbell flyes':'Dumbbell Fly',
  'incline dumbbell flyes':'Dumbbell Incline Fly',
  'incline dumbbell fly':'Dumbbell Incline Fly',
  'incline fly':'Dumbbell Incline Fly',
  // Press variants
  'incline barbell press':'Barbell Incline Bench Press',
  'incline bench':'Barbell Incline Bench Press',
  'close grip bench press':'Barbell Close Grip Bench Press',
  'close grip press':'Barbell Close Grip Bench Press',
  'decline press':'Barbell Decline Bench Press',
  // Row variants
  'cable seated row':'Cable Seated Row',
  'seated cable row':'Cable Seated Row',
  'low cable row':'Cable Seated Row',
  // Curl variants
  'standing barbell curl':'Barbell Curl',
  'standing bicep curl':'Barbell Curl',
  'incline dumbbell curl':'Dumbbell Incline Curl',
  'incline curl':'Dumbbell Incline Curl',
  // Leg variants
  'barbell hip thrust':'Barbell Hip Thrust',
  'hip thrusts':'Barbell Hip Thrust',
  'stiff leg deadlift':'Barbell Stiff Leg Deadlift',
  'straight leg deadlift':'Barbell Stiff Leg Deadlift',
  'hack squat':'Machine Hack Squat',
  'smith machine squat':'Smith Machine Squat',
  // Pull variants
  'wide grip pulldown':'Cable Wide Grip Lat Pulldown',
  'close grip pulldown':'Cable Close Grip Lat Pulldown',
  'neutral grip pulldown':'Cable Neutral Grip Lat Pulldown',
  'bodyweight pullup':'Bodyweight Pull Up',
  'bodyweight pull-up':'Bodyweight Pull Up',
  'weighted pull up':'Weighted Pull Up',
  // Core
  'hanging leg raise':'Bodyweight Hanging Leg Raise',
  'cable wood chop':'Cable Wood Chop',
  // Misc
  'barbell upright row':'Barbell Upright Row',
  'dumbbell upright row':'Dumbbell Upright Row',
  'dumbbell arnold press':'Dumbbell Arnold Press',
  'face pulls':'Cable Face Pull',
  'cable face pull':'Cable Face Pull',
  'dumbbell kickback':'Dumbbell Tricep Kickback',
  'tricep kickback':'Dumbbell Tricep Kickback',
  'dumbbell tricep kickback':'Dumbbell Tricep Kickback',
};

// Resolve AI exercise name -> exact MuscleWiki name
// Priority: manual map -> fuzzy cache match -> AI normalisation
async function resolveExerciseName(name, exercises) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();

  // 1. Manual map (instant)
  if (MANUAL_EXERCISE_MAP[lower]) return MANUAL_EXERCISE_MAP[lower];

  // 2. Stripped manual map (remove equipment prefix)
  const stripped = lower.replace(/^(barbell|dumbbell|cable|machine|kettlebell|ez bar|ez-bar|bodyweight|bw|db|bb|kb)\s+/i, '');
  if (stripped !== lower && MANUAL_EXERCISE_MAP[stripped]) return MANUAL_EXERCISE_MAP[stripped];

  // 3. AI cache
  const aiCached = aiExerciseNameCache.get(lower);
  if (aiCached !== undefined) return aiCached;

  // 4. AI normalisation (async, uses claude-haiku)
  const aiResult = await normaliseExerciseNameWithAI(name, exercises);
  return aiResult;
}

// Pre-warm detail cache for common exercises — runs in background after list loads
async function prewarmDetailCache(exercises) {
  if (!exercises?.length || !process.env.MUSCLEWIKI_API_KEY) return;
  // Common exercises the AI generates — pre-fetch their details
  const commonNames = [
    'Barbell Bench Press','Barbell Squat','Barbell Deadlift','Barbell Romanian Deadlift',
    'Barbell Overhead Press','Barbell Row','Barbell Curl','Barbell Hip Thrust',
    'Dumbbell Bench Press','Dumbbell Incline Press','Dumbbell Shoulder Press',
    'Dumbbell Lateral Raise','Dumbbell Fly','Dumbbell Romanian Deadlift',
    'Dumbbell Curl','Dumbbell Hammer Curl','Dumbbell Row','Dumbbell Lunge',
    'Cable Lateral Raise','Cable Fly','Cable Row','Cable Tricep Pushdown',
    'Cable Rope Tricep Pushdown','Cable Bicep Curl','Cable Face Pull',
    'Machine Leg Press','Machine Leg Extension','Machine Lying Leg Curl',
    'Machine Calf Raise','Machine Chest Press','Machine Lat Pulldown',
    'Bodyweight Pull Up','Bodyweight Dip','Bodyweight Push Up',
    'EZ Bar Curl','EZ Bar Skull Crusher',
  ];
  const toFetch = exercises.filter(e => commonNames.some(n => e.name === n) && !_detailCache.has(e.id));
  console.log('Pre-warming detail cache for', toFetch.length, 'common exercises...');
  // Fetch in small batches of 5 to avoid rate limits
  for (let i = 0; i < toFetch.length; i += 5) {
    const batch = toFetch.slice(i, i + 5);
    await Promise.all(batch.map(async (ex) => {
      try {
        const r = await fetch('https://api.musclewiki.com/exercises/' + ex.id, {
          headers: { 'X-API-Key': process.env.MUSCLEWIKI_API_KEY, 'Accept': 'application/json' }
        });
        if (r.ok) { const d = await r.json(); _detailCache.set(ex.id, { ...ex, ...d }); }
      } catch(e) {}
    }));
    await new Promise(r => setTimeout(r, 300)); // small delay between batches
  }
  console.log('Detail cache pre-warmed:', _detailCache.size, 'exercises ready');
}

// ── PERSISTENT EXERCISE LOOKUP CACHE (Supabase) ──────────────────────
// Stores: ai_name (lowercase) → { mw_id, mw_name, mw_video_front, mw_video_side }
// Shared across ALL users — one lookup benefits everyone forever
// SQL: CREATE TABLE exercise_lookup_cache (
//   ai_name text PRIMARY KEY, mw_id integer, mw_name text,
//   mw_video_front text, mw_video_side text, updated_at timestamptz DEFAULT now()
// );

const _localLookupCache = new Map(); // in-memory layer on top of Supabase
const _detailCache = new Map(); // id -> full exercise detail with videos

async function getExerciseLookup(aiNameLower) {
  const localCached = _localLookupCache.get(aiNameLower);
  if (localCached) return localCached;
  try {
    const { data } = await supabase
      .from('exercise_lookup_cache')
      .select('mw_id, mw_name, mw_video_front, mw_video_side')
      .eq('ai_name', aiNameLower)
      .maybeSingle();
    if (data) { _localLookupCache.set(aiNameLower, data); return data; }
  } catch(e) { /* table may not exist yet */ }
  return null;
}

async function saveExerciseLookup(aiName, mwExercise) {
  if (!aiName || !mwExercise) return;
  const aiNameLower = aiName.toLowerCase().trim();
  const videos = mwExercise.videos || [];
  const front = videos.find(v => v.gender === 'male' && v.angle === 'front') || videos[0];
  const side  = videos.find(v => v.gender === 'male' && v.angle === 'side');
  const getFile = v => v?.url ? v.url.split('/branded/')[1] : null;
  const entry = {
    mw_id: mwExercise.id || mwExercise.pk,
    mw_name: mwExercise.name,
    mw_video_front: getFile(front) || null,
    mw_video_side: getFile(side) || null,
  };
  _localLookupCache.set(aiNameLower, entry);
  // Upsert to Supabase — fire and forget
  supabase.from('exercise_lookup_cache').upsert({
    ai_name: aiNameLower, ...entry, updated_at: new Date().toISOString()
  }, { onConflict: 'ai_name' }).catch(() => {});
}

// ── CLIENTS ────────────────────────────────────
// Module-level singletons — created ONCE, reused across all requests (correct for
// Supabase/Anthropic which use stateless HTTP, not persistent connection pools).
// Anthropic gets an explicit request timeout so a hung upstream call fails fast
// instead of holding a worker until the 180s server socket timeout.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120 * 1000, // 120s ceiling per AI call (plan gen with haiku can run long)
  maxRetries: 2,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── EMAIL (Resend) ─────────────────────────────────────
// Transactional email (welcome, referral, etc.) via Resend. Supabase Auth still sends
// the password-reset + signup-confirmation emails. Defensive require: a missing module
// or unset RESEND_API_KEY degrades to a logged no-op instead of crashing the server.
// DEPLOY STEPS: add "resend" to package.json + `npm install`, then set RESEND_API_KEY
// (and optionally FROM_EMAIL) in the Railway env. Until then, sendEmail() is a no-op.
let _Resend = null;
try { _Resend = require('resend').Resend; } catch (e) { console.warn('[email] resend module not installed — transactional emails disabled'); }
const resend = (_Resend && process.env.RESEND_API_KEY) ? new _Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@klemforge.com';
const FROM_NAME = 'FORGE';

async function sendEmail(to, subject, html) {
  if (!resend) { console.warn('[email] RESEND_API_KEY not set — skipping email:', subject); return false; }
  try {
    const { error } = await resend.emails.send({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to, subject, html });
    if (error) { console.error('[email] Send error:', error); return false; }
    return true;
  } catch (err) {
    console.error('[email] Exception:', err.message);
    return false;
  }
}

// ── BOOT MIGRATIONS (best-effort) ──────────────────────
// Adds columns newer features need. The Supabase JS client can't run raw DDL, so
// this calls an optional `run_sql` RPC if the project defines one; if it doesn't,
// the .catch swallows it and the canonical migration is the SQL below — run once
// in the Supabase SQL editor:
//   ALTER TABLE profiles   ADD COLUMN IF NOT EXISTS units text DEFAULT 'kg';
//   ALTER TABLE programmes ADD COLUMN IF NOT EXISTS description text;
//   ALTER TABLE profiles   ADD COLUMN IF NOT EXISTS enabled_features jsonb DEFAULT '["plans","nutrition","progress","prs","coach","logging"]'::jsonb;
//   ALTER TABLE programmes ADD COLUMN IF NOT EXISTS programme_type text DEFAULT 'workout';
//   ALTER TABLE profiles   ADD COLUMN IF NOT EXISTS session_duration_mins int DEFAULT 60;
//   ALTER TABLE profiles   ADD COLUMN IF NOT EXISTS session_duration_varies boolean DEFAULT false;
//   ALTER TABLE profiles   ADD COLUMN IF NOT EXISTS session_duration_by_day jsonb DEFAULT null;
// PATCH /api/profile degrades gracefully if profiles.units / enabled_features is still
// absent, and the frontend caches both in localStorage, so the app works either way.
const BOOT_MIGRATIONS = [
  `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS units text DEFAULT 'kg'`,
  `ALTER TABLE programmes ADD COLUMN IF NOT EXISTS description text`,
  `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS enabled_features jsonb DEFAULT '["plans","nutrition","progress","prs","coach","logging"]'::jsonb`,
  // Custom programme builder stores its origin here ('custom'); AI/onboarding plans default to 'workout'.
  `ALTER TABLE programmes ADD COLUMN IF NOT EXISTS programme_type text DEFAULT 'workout'`,
  // Onboarding session-duration question. Single value in minutes, or per-day when it varies.
  `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS session_duration_mins int DEFAULT 60`,
  `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS session_duration_varies boolean DEFAULT false`,
  `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS session_duration_by_day jsonb DEFAULT null`,
  // Daily workout reminder: preferred LOCAL time ('HH:MM') + IANA timezone. NULL = no reminder.
  `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS reminder_time text DEFAULT NULL`,
  `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS reminder_timezone text DEFAULT 'UTC'`,
];
(async () => {
  for (const sql of BOOT_MIGRATIONS) {
    try { await supabase.rpc('run_sql', { sql }); }
    catch (e) { /* no run_sql RPC — apply the SQL above in the Supabase SQL editor */ }
  }
})();

// ── STRIPE ─────────────────────────────────────────────
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('Stripe initialised ✓');
  } else {
    console.warn('STRIPE_SECRET_KEY not set — Stripe features disabled');
  }
} catch(e) {
  console.error('Stripe init failed:', e.message);
}

// Price ID map — swap these for live IDs when going to production
const STRIPE_PRICES = {
  iron_monthly:        process.env.STRIPE_PRICE_IRON_MONTHLY        || 'price_1TRVyYCP6MFAx438g7OtULUQ',
  iron_annual:         process.env.STRIPE_PRICE_IRON_ANNUAL         || 'price_1TRVz4CP6MFAx438Bph4XBhA',
  steel_monthly:       process.env.STRIPE_PRICE_STEEL_MONTHLY       || 'price_1TRVzOCP6MFAx438TZ91bkEL',
  steel_annual:        process.env.STRIPE_PRICE_STEEL_ANNUAL        || 'price_1TRW00CP6MFAx4383yXNBGFU',
  forge_monthly:       process.env.STRIPE_PRICE_FORGE_MONTHLY       || 'price_1TRW0OCP6MFAx438U9PU9vMV',
  forge_annual:        process.env.STRIPE_PRICE_FORGE_ANNUAL        || 'price_1TRW0jCP6MFAx438kn5AaNUk',
  steel_monthly_promo: process.env.STRIPE_PRICE_STEEL_MONTHLY_PROMO || 'price_1TRW19CP6MFAx438Z9q3divk',
  steel_annual_promo:  process.env.STRIPE_PRICE_STEEL_ANNUAL_PROMO  || 'price_1TRW1hCP6MFAx438y1Ce7oNs',
  forge_monthly_promo: process.env.STRIPE_PRICE_FORGE_MONTHLY_PROMO || 'price_1TRW27CP6MFAx438cccyiUmk',
  forge_annual_promo:  process.env.STRIPE_PRICE_FORGE_ANNUAL_PROMO  || 'price_1TRW2YCP6MFAx438qTEPAtwj',
  iron_founding:       process.env.STRIPE_PRICE_IRON_FOUNDING       || 'price_1TRW33CP6MFAx438rk9GZZ6P',
  steel_founding:      process.env.STRIPE_PRICE_STEEL_FOUNDING      || 'price_1TRW3PCP6MFAx438tgVOex9V',
  // Coach plans — create in Stripe dashboard, set as env vars on Railway
  coach_starter_monthly: process.env.STRIPE_PRICE_COACH_STARTER_MONTHLY || '',
  coach_starter_annual:  process.env.STRIPE_PRICE_COACH_STARTER_ANNUAL  || '',
  coach_pro_monthly:     process.env.STRIPE_PRICE_COACH_PRO_MONTHLY     || '',
  coach_pro_annual:      process.env.STRIPE_PRICE_COACH_PRO_ANNUAL      || '',
  coach_elite_monthly:   process.env.STRIPE_PRICE_COACH_ELITE_MONTHLY   || '',
  coach_elite_annual:    process.env.STRIPE_PRICE_COACH_ELITE_ANNUAL    || '',
};

// ── COACH PLAN CONFIG ──────────────────────────────────
// Seat limits and commission rates per coach plan. Shared with frontend.
const COACH_PLAN_CONFIG = {
  starter: { seatLimit: 10,       commissionRate: 10 },
  pro:     { seatLimit: 30,       commissionRate: 15 },
  elite:   { seatLimit: Infinity, commissionRate: 20 },
};

// Map coach price IDs back to plan name — used by webhook
function getCoachPlanFromPriceId(priceId) {
  const map = {};
  Object.entries(STRIPE_PRICES).forEach(([key, id]) => {
    if (!id) return;
    if (key.startsWith('coach_starter')) map[id] = 'starter';
    else if (key.startsWith('coach_pro')) map[id] = 'pro';
    else if (key.startsWith('coach_elite')) map[id] = 'elite';
  });
  return map[priceId] || null;
}

// Map price IDs back to tiers — used by webhook and sync endpoint
function getTierFromPriceId(priceId) {
  const map = {};
  Object.entries(STRIPE_PRICES).forEach(([key, id]) => {
    if (key.startsWith('iron')) map[id] = 'iron';
    else if (key.startsWith('steel')) map[id] = 'steel';
    else if (key.startsWith('forge')) map[id] = 'forge';
  });
  return map[priceId] || null;
}

// ── MIDDLEWARE ─────────────────────────────────
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.FRONTEND_URL,
      'https://kevinklem9-dot.github.io',
      'https://www.klemforge.com',
      'https://klemforge.com',
      // Dev origins only outside production — never trust localhost in prod.
      ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080'] : []),
    ].filter(Boolean);
    if (allowed.some(o => origin.startsWith(o))) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
};
app.use(helmet({ contentSecurityPolicy: false })); // Security headers
// Explicit hardening on top of helmet — DENY framing outright (helmet defaults to
// SAMEORIGIN) and lock down powerful browser features the app never uses.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle all preflight requests
// Stripe webhook needs raw body — must come BEFORE express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        const tier = session.metadata?.tier;
        const billing = session.metadata?.billing; // 'monthly', 'annual', 'lifetime'
        const isPromo = session.metadata?.is_promo === 'true';
        const isCoachSetup = session.metadata?.account_type === 'coach';

        // ── COACH PLAN CHECKOUT ─────────────────────────
        if (isCoachSetup && userId) {
          const coachPlan = session.metadata?.coach_plan;
          const coachBio = session.metadata?.coach_bio || null;
          const coachTitle = session.metadata?.coach_title || null;
          const isPostTrial = session.metadata?.coach_post_trial === 'true';
          const planConfig = COACH_PLAN_CONFIG[coachPlan];
          if (planConfig) {
            const update = {
              account_type: 'coach',
              coach_plan: coachPlan,
              coach_plan_status: 'active',
              coach_stripe_subscription_id: session.subscription,
              coach_commission_rate: planConfig.commissionRate,
              stripe_customer_id: session.customer,
            };
            // Post-trial reactivation: do NOT touch coach_trial_start (trial already happened),
            // and don't overwrite title/bio if not provided.
            if (!isPostTrial) {
              update.coach_trial_start = new Date().toISOString();
              if (coachBio) update.coach_bio = coachBio;
              if (coachTitle) update.coach_title = coachTitle;
            }
            await supabase.from('profiles').update(update).eq('id', userId);
          }
          break;
        }

        if (!userId || !tier) break;

        if (billing === 'lifetime') {
          // Founding member — set lifetime status
          await supabase.from('profiles').update({
            subscription_tier: tier,
            subscription_status: 'lifetime',
            lifetime_tier: tier,
            stripe_customer_id: session.customer,
          }).eq('id', userId);
          // Increment founding member counter
          const { data: fmConfig } = await supabase.from('founding_member_config').select('*').maybeSingle();
          await supabase.from('founding_member_config').upsert({
            id: 1,
            [`${tier}_sold`]: (fmConfig?.[`${tier}_sold`] || 0) + 1,
            iron_total: fmConfig?.iron_total || 500,
            steel_total: fmConfig?.steel_total || 250,
          });
        } else {
          // Subscription — set active
          await supabase.from('profiles').update({
            subscription_tier: tier,
            subscription_status: 'active',
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
          }).eq('id', userId);
          // Increment launch promo counter if applicable
          if (isPromo && ['steel','forge'].includes(tier)) {
            await stripe_recordLaunchSub(tier);
          }
          // Handle referral credit
          await handleReferralConversion(userId);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        // Check coach subscription first
        const { data: coachProfile } = await supabase.from('profiles')
          .select('id').eq('coach_stripe_subscription_id', sub.id).maybeSingle();
        if (coachProfile) {
          await supabase.from('profiles').update({
            coach_plan_status: 'cancelled',
          }).eq('id', coachProfile.id);
          break;
        }
        // Fall through to individual subscription
        const { data: profile } = await supabase.from('profiles')
          .select('id').eq('stripe_subscription_id', sub.id).maybeSingle();
        if (profile) {
          await supabase.from('profiles').update({
            subscription_status: 'expired',
            subscription_tier: 'iron',
          }).eq('id', profile.id);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        // Check coach subscription first
        const { data: coachProfile } = await supabase.from('profiles')
          .select('id').eq('coach_stripe_subscription_id', sub.id).maybeSingle();
        if (coachProfile) {
          const priceId = sub.items?.data?.[0]?.price?.id;
          const planFromPrice = priceId ? getCoachPlanFromPriceId(priceId) : null;
          let coachStatus;
          if (sub.status === 'trialing') coachStatus = 'trial';
          else if (sub.status === 'active') coachStatus = 'active';
          else if (sub.status === 'past_due') coachStatus = 'past_due';
          else coachStatus = 'cancelled';
          const updateData = { coach_plan_status: coachStatus };
          if (planFromPrice) {
            updateData.coach_plan = planFromPrice;
            updateData.coach_commission_rate = COACH_PLAN_CONFIG[planFromPrice]?.commissionRate || 0;
          }
          await supabase.from('profiles').update(updateData).eq('id', coachProfile.id);
          break;
        }
        // Fall through to individual subscription
        const { data: profile } = await supabase.from('profiles')
          .select('id').eq('stripe_subscription_id', sub.id).maybeSingle();
        if (profile) {
          const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : 'expired';
          // Determine tier from the active price ID
          const priceId = sub.items?.data?.[0]?.price?.id;
          const tierFromPrice = priceId ? getTierFromPriceId(priceId) : null;
          const updateData = { subscription_status: status };
          if (tierFromPrice) updateData.subscription_tier = tierFromPrice;
          await supabase.from('profiles').update(updateData).eq('id', profile.id);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const { data: profile } = await supabase.from('profiles')
          .select('id').eq('stripe_customer_id', invoice.customer).maybeSingle();
        if (profile) {
          await supabase.from('profiles').update({ subscription_status: 'past_due' }).eq('id', profile.id);
        }
        break;
      }
    }
    res.json({ received: true });
  } catch(err) {
    console.error('Webhook handler error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper: record launch promo subscription
async function stripe_recordLaunchSub(tier) {
  try {
    const { data: config } = await supabase.from('launch_pricing_config').select('*').maybeSingle();
    const newSold = (config?.[`${tier}_sold`] || 0) + 1;
    const nowEnded = newSold >= 500;
    await supabase.from('launch_pricing_config').upsert({
      id: 1,
      steel_active: tier === 'steel' ? !nowEnded : (config?.steel_active ?? true),
      steel_sold: tier === 'steel' ? newSold : (config?.steel_sold || 0),
      forge_active: tier === 'forge' ? !nowEnded : (config?.forge_active ?? true),
      forge_sold: tier === 'forge' ? newSold : (config?.forge_sold || 0),
    });
  } catch(e) { console.error('stripe_recordLaunchSub error:', e.message); }
}

// Helper: handle referral conversion credit
async function handleReferralConversion(userId) {
  try {
    const { data: profile } = await supabase.from('profiles')
      .select('referred_by').eq('id', userId).maybeSingle();
    if (!profile?.referred_by) return;
    const referrerId = profile.referred_by;
    const { data: referrer } = await supabase.from('profiles')
      .select('referral_stats, stripe_subscription_id').eq('id', referrerId).maybeSingle();
    if (!referrer) return;
    const stats = referrer.referral_stats || {};
    stats.conversions = (stats.conversions || 0) + 1;
    stats.credits = (stats.credits || 0) + 1;
    await supabase.from('profiles').update({ referral_stats: stats }).eq('id', referrerId);
    // Send push notification to referrer
    await sendPushToUser(referrerId, 'FORGE', 'Someone you referred just joined FORGE. A free month has been added to your account.');
  } catch(e) { console.error('handleReferralConversion error:', e.message); }
}

app.use(express.json({ limit: '500kb' }));

// Rate limiting — protect against abuse. Skipped entirely outside production so
// staging (NODE_ENV=development) never blocks testing.
const skipNonProd = (req) => process.env.NODE_ENV !== 'production';
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, skip: skipNonProd });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, skip: skipNonProd });
const planLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, skip: skipNonProd, message: { error: 'Too many plan generations — try again in an hour.' } });
const checkinLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, skip: skipNonProd, message: { error: 'Too many check-ins — slow down.' } });
const signupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, skip: skipNonProd, message: { error: 'Too many signups — try again later.' } });
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, skip: skipNonProd, message: { error: 'Too many reset attempts — try again later.' } });
app.use('/api/', limiter);
app.use('/api/chat', chatLimiter);
app.use('/api/generate-plan', planLimiter);
app.use('/api/checkin', checkinLimiter);

// ── REQUEST TIMEOUT ────────────────────────────
// Fail a stuck request at 30s instead of holding the socket open to the 180s
// server timeout. The long-running AI endpoints (plan/chat/checkin/review/translate)
// and the raw-socket video proxy are EXCLUDED — they legitimately run past 30s and
// manage their own timeouts/heartbeats. A blanket 30s timeout here would kill them.
const TIMEOUT_EXEMPT = [
  '/api/generate-plan', '/api/chat', '/api/checkin', '/api/translate-plan',
  '/api/review/generate', '/api/monthly-review/generate',
  '/api/exercise/video', '/api/exercise/buftest',
];
app.use((req, res, next) => {
  if (!TIMEOUT_EXEMPT.some(p => req.path.startsWith(p))) {
    res.setTimeout(30000, () => {
      if (!res.headersSent) res.status(408).json({ error: 'Request timeout' });
    });
  }
  next();
});

// ── CACHE CONTROL ──────────────────────────────
// Most API responses carry personal (health/fitness/billing) data — keep them out of
// shared/proxy/browser caches so stale or cross-user data can never be served. The few
// genuinely public, slow-changing endpoints opt into a short cache for performance.
const PUBLIC_CACHEABLE = ['/api/launch-pricing', '/api/testimonial', '/api/version', '/api/founding-member/slots', '/api/vapid-public-key'];
app.use((req, res, next) => {
  if (req.path === '/health' || PUBLIC_CACHEABLE.some(p => req.path.startsWith(p))) {
    res.setHeader('Cache-Control', 'public, max-age=300');
  } else if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'private, no-store');
  }
  next();
});

// ── AUTH MIDDLEWARE ────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorised' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    console.warn(`Auth failed: ${req.ip} — ${error?.message || 'invalid token'}`);
    return res.status(401).json({ error: 'Invalid token' });
  }

  req.user = user;

  // Check frozen status on every authenticated request
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_frozen, subscription_tier, subscription_status, trial_ends_at, is_exempt')
    .eq('id', user.id)
    .maybeSingle();

  if (profile?.is_frozen) {
    return res.status(403).json({
      error: 'account_frozen',
      message: 'Your account has been suspended. Contact support to resolve this.'
    });
  }

  // Cache profile data on request so loadSubscription doesn't need to re-fetch
  req.profileCache = profile || null;
  next();
}


function requireAdmin(req, res, next) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL not configured' });
  if (req.user?.email !== adminEmail) {
    console.error('[admin] Unauthorised access attempt');
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}


// ── SELECT FIELD LISTS ─────────────────────────
// Explicit column lists replace select('*') on wide/heavy tables. `profiles` has
// 30+ columns; `plans` carries large workout/nutrition jsonb plus a `translations`
// cache (up to 12 languages) that most reads do not need.
// Standard minimal profile select for account/subscription checks:
const PROFILE_FIELDS = 'id, name, subscription_tier, subscription_status, trial_ends_at, account_type, coach_plan, coach_plan_status';
// Fields the AI prompt builders actually read off a profile:
const COACH_PROFILE_FIELDS = 'name, age, sex, height_cm, weight_kg, goal, experience, days_per_week, equipment, diet_style, diet_restrictions, injuries';
const PLAN_PROFILE_FIELDS = 'name, age, sex, height_cm, weight_kg, goal, experience, days_per_week, preferred_days, equipment, diet_style, diet_restrictions, injuries, session_duration_mins, session_duration_varies, session_duration_by_day';
// The live plan WITHOUT the heavy translations blob (chat/checkin only edit the plan):
const PLAN_CORE_FIELDS = 'id, workout_plan, nutrition_plan';
// Exercise-history columns the prompt builders read:
const HISTORY_PROMPT_FIELDS = 'exercise_name, sets, reps, weight_kg, logged_at';

// ── SUBSCRIPTION HELPERS ───────────────────────
const TIER_RANK = { iron: 0, steel: 1, forge: 2 };

const TIER_FEATURES = {
  unlimited_coach:    ['steel', 'forge'],
  weekly_review:      ['steel', 'forge'],
  checkin:            ['steel', 'forge'],
  overload_tracker:   ['steel', 'forge'],
  body_metrics:       ['steel', 'forge'],
  plan_editing:       ['steel', 'forge'],
  deload:             ['steel', 'forge'],
  shopping_list:      ['steel', 'forge'],
  multiple_programmes:['steel', 'forge'],
  export_history:     ['steel', 'forge'],
  video_demos:        ['forge'],
  barcode_scanner:    ['forge'],
  wearable_sync:      ['forge'],
  monthly_review:     ['forge'],
  priority_support:   ['forge'],
  early_access:       ['forge'],
};

function hasAccess(feature, tier, isExempt) {
  if (isExempt) return true;
  const allowed = TIER_FEATURES[feature];
  if (!allowed) return true; // unknown feature = open
  return allowed.includes(tier || 'iron');
}

// Load subscription info onto req.subscription
async function loadSubscription(req, res, next) {
  try {
    // Use cached profile from requireAuth if available, otherwise fetch
    const profile = req.profileCache || (await supabase
      .from('profiles')
      .select('subscription_tier, subscription_status, trial_ends_at, is_exempt, is_frozen')
      .eq('id', req.user.id)
      .maybeSingle()).data;

    const tier = profile?.is_exempt ? 'forge' : (profile?.subscription_tier || 'iron');
    const status = profile?.subscription_status || 'trial';
    const isExempt = profile?.is_exempt || false;

    // If trial but no trial_ends_at set (old account), set it now
    if (status === 'trial' && !profile?.trial_ends_at && profile?.id) {
      const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      supabase.from('profiles').update({ trial_ends_at: trialEndsAt }).eq('id', req.user.id).then(() => {});
    }

    // Check trial expiry
    let effectiveTier = tier;
    let effectiveStatus = status;
    if (status === 'trial' && profile?.trial_ends_at) {
      const trialEnd = new Date(profile.trial_ends_at);
      if (trialEnd < new Date()) {
        effectiveTier = 'iron';
        effectiveStatus = 'expired';
        // Update DB asynchronously
        supabase.from('profiles')
          .update({ subscription_status: 'expired' })
          .eq('id', req.user.id)
          .then(() => {});
      }
    }

    // ── ENTITLEMENT GUARD (security) ──────────────────────────────────────
    // A stored subscription_tier must only grant paid access when the subscription
    // is actually paid/active. PATCH /api/subscription/tier lets a user set a
    // cosmetic tier "preference" during the trial; without this guard that value
    // would persist as a real entitlement after the trial ends, letting anyone keep
    // Steel/Forge access for free. Trial access is granted separately below
    // (accessTier='forge'). Exempt accounts bypass this.
    const PAID_STATUSES = ['active', 'past_due', 'lifetime'];
    if (!isExempt && effectiveStatus !== 'trial' && !PAID_STATUSES.includes(effectiveStatus)) {
      effectiveTier = 'iron';
    }

    // During trial, full access to everything — best sales tool
    const accessTier = (effectiveStatus === 'trial' && !isExempt) ? 'forge' : effectiveTier;

    req.subscription = {
      tier: effectiveTier,
      accessTier,
      status: effectiveStatus,
      isExempt,
      trialEndsAt: profile?.trial_ends_at || null,
    };
    next();
  } catch(e) {
    // Don't block request on subscription load failure
    req.subscription = { tier: 'iron', accessTier: 'iron', status: 'active', isExempt: false };
    next();
  }
}

// ── BILLING MONTH ─────────────────────────────────
function billingMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── COACH MESSAGE TRACKING ────────────────────────
async function getCoachUsage(userId) {
  const month = billingMonth();
  const { data } = await supabase
    .from('ai_coach_usage')
    .select('message_count')
    .eq('user_id', userId)
    .eq('month', month)
    .maybeSingle();
  return data?.message_count || 0;
}

async function incrementCoachUsage(userId) {
  const month = billingMonth();
  // Fetch current count first
  const { data: existing } = await supabase
    .from('ai_coach_usage')
    .select('id, message_count')
    .eq('user_id', userId)
    .eq('month', month)
    .maybeSingle();

  if (existing) {
    // Row exists — increment
    await supabase.from('ai_coach_usage')
      .update({ message_count: (existing.message_count || 0) + 1, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    // First message this month — insert with count 1
    await supabase.from('ai_coach_usage').insert({
      user_id: userId,
      month,
      message_count: 1,
      updated_at: new Date().toISOString()
    });
  }
}

// ── HEALTH CHECK ───────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'FORGE' }));

// Public VAPID key — safe to expose, needed by frontend for push subscription
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || '' });
});

// ── SIGNUP — Check email + create account ──────
app.post('/api/signup', signupLimiter, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    // Use signUp (not admin.createUser) so Supabase sends confirmation email automatically
    // This respects the "Enable email confirmations" setting in the Supabase dashboard
    const supabaseAnon = require('@supabase/supabase-js').createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data, error } = await supabaseAnon.auth.signUp({
      email,
      password,
      options: {
        data: { name },
        emailRedirectTo: process.env.FRONTEND_URL
      }
    });

    if (error) {
      if (error.message?.toLowerCase().includes('already') || error.message?.toLowerCase().includes('duplicate') || error.code === 'email_exists' || error.message?.toLowerCase().includes('registered')) {
        return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
      }
      throw error;
    }

    // If user already exists and is confirmed, Supabase returns a user with no identities
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
    }

    // Save name to profile + set 7-day trial (profile row created by trigger)
    // Retry up to 5 times — trigger may not have created the profile row yet
    if (data.user?.id) {
      const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      let profileSet = false;
      for (let attempt = 1; attempt <= 5; attempt++) {
        await new Promise(r => setTimeout(r, 300 * attempt)); // 300ms, 600ms, 900ms...
        const { data: updated, error: updateErr } = await supabase
          .from('profiles')
          .update({
            name,
            subscription_tier: 'iron',
            subscription_status: 'trial',
            trial_ends_at: trialEndsAt
          })
          .eq('id', data.user.id)
          .select('id')
          .maybeSingle();
        if (updated?.id) { profileSet = true; break; }
        if (attempt === 5) console.error('Profile update failed after 5 attempts:', updateErr?.message);
      }
      // If profile row still doesn't exist, upsert it
      if (!profileSet) {
        await supabase.from('profiles').upsert({
          id: data.user.id,
          name,
          subscription_tier: 'iron',
          subscription_status: 'trial',
          trial_ends_at: trialEndsAt
        });
      }
    }

    // Handle creator code or referral code
    const { code } = req.body;
    if (code && data.user?.id) {
      if (code.startsWith('FORGE-')) {
        // Referral code
        const { data: referrer } = await supabase.from('profiles').select('id, referral_stats').eq('referral_code', code).maybeSingle();
        if (referrer) {
          const extendedTrial = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
          await supabase.from('profiles').update({ trial_ends_at: extendedTrial, referred_by: referrer.id }).eq('id', data.user.id);
          const stats = referrer.referral_stats || {};
          stats.signups = (stats.signups || 0) + 1;
          await supabase.from('profiles').update({ referral_stats: stats }).eq('id', referrer.id);
        }
      } else {
        // Creator code
        const { data: codeRow } = await supabase.from('creator_codes').select('*').eq('code', code.toUpperCase()).maybeSingle();
        if (codeRow && !(codeRow.expires_at && new Date(codeRow.expires_at) < new Date()) && !(codeRow.max_uses && codeRow.uses_count >= codeRow.max_uses)) {
          const extendedTrial = new Date(Date.now() + (codeRow.trial_days || 14) * 24 * 60 * 60 * 1000).toISOString();
          await supabase.from('profiles').update({ trial_ends_at: extendedTrial }).eq('id', data.user.id);
          await supabase.from('creator_codes').update({ uses_count: (codeRow.uses_count || 0) + 1 }).eq('id', codeRow.id);
          await supabase.from('creator_code_uses').insert({ code_id: codeRow.id, user_id: data.user.id, used_at: new Date().toISOString() }).catch(() => {});
        }
      }
    }

    // Welcome email — fire-and-forget. Never awaited; never blocks/fails the signup response.
    sendEmail(
      email,
      `Welcome to FORGE, ${name}.`,
      `<!DOCTYPE html>
<html lang="en" style="color-scheme:dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Welcome to FORGE</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;-webkit-text-size-adjust:100%">

<div style="display:none;font-size:1px;color:#0a0a0a;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">
Your programme is ready to build. Here's where to start.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a">
<tr><td align="center" style="padding:40px 20px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0a0a0a">

<!-- HEADER -->
<tr><td style="padding:36px 24px 32px;text-align:center;border-bottom:1px solid #1a1a1a">
  <div style="font-family:'Bebas Neue',Georgia,serif;font-size:36px;font-weight:700;color:#e8ff3d;letter-spacing:4px;line-height:1;margin-bottom:6px">FORGE</div>
  <div style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#888;letter-spacing:4px;text-transform:uppercase">AI Performance Coach</div>
</td></tr>

<!-- HERO -->
<tr><td style="padding:36px 24px 28px">
  <div style="font-family:'Bebas Neue',Georgia,serif;font-size:40px;font-weight:700;color:#f0f0f0;letter-spacing:1px;line-height:1;margin-bottom:10px">Welcome, ${name}.</div>
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:20px;color:#e8ff3d;font-weight:500;margin-bottom:12px">Let's build something.</div>
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;color:#c8c8c8;line-height:1.7"><span style="font-family:'Courier New',Courier,monospace;color:#e8ff3d;font-weight:500">7 days</span> of full access. Here's how to use every one.</div>
</td></tr>

<!-- STEPS CARD -->
<tr><td style="padding:0 24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111111;border:1px solid #222;border-radius:16px;overflow:hidden">

  <tr><td style="padding:22px 24px;border-bottom:1px solid #1a1a1a">
    <div style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#666;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">01</div>
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#f0f0f0;margin-bottom:8px">Finish your onboarding</div>
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;color:#bbbbbb;line-height:1.7">If you haven't completed your profile yet — do it now. Your sport, your schedule, your goals, your injury history. The more honest your answers, the sharper your programme. This is the step most people rush. <strong style="color:#f0f0f0;font-weight:600">Don't.</strong></div>
  </td></tr>

  <tr><td style="padding:22px 24px;border-bottom:1px solid #1a1a1a">
    <div style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#666;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">02</div>
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#f0f0f0;margin-bottom:8px">Talk to your coach</div>
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;color:#bbbbbb;line-height:1.7">Your AI coach is live the moment onboarding is done. Ask it anything — form, nutrition, when to add weight, how to adjust your plan around an injury. It reads your data and gives you a real answer. <strong style="color:#f0f0f0;font-weight:600">Use it.</strong></div>
  </td></tr>

  <tr><td style="padding:22px 24px;border-bottom:1px solid #1a1a1a">
    <div style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#666;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">03</div>
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#f0f0f0;margin-bottom:8px">Log every session</div>
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;color:#bbbbbb;line-height:1.7">Every set you log makes your coach smarter. The programme adapts based on what your data actually shows — not what it guessed about you on day one. <strong style="color:#f0f0f0;font-weight:600">Log everything. Miss nothing.</strong></div>
  </td></tr>

  <tr><td style="padding:22px 24px">
    <div style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#666;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">04</div>
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#f0f0f0;margin-bottom:8px">Set a daily reminder</div>
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;color:#bbbbbb;line-height:1.7">Go to <span style="font-family:'Courier New',Courier,monospace;color:#e8ff3d;font-size:13px;letter-spacing:0.5px">Account → Workout Reminder</span> and set a time. One push notification a day. The sessions you almost skip are the ones that matter most.</div>
  </td></tr>

</table>
</td></tr>

<!-- CTA -->
<tr><td style="padding:28px 24px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  <tr><td style="background:#e8ff3d;border-radius:10px;text-align:center;padding:18px">
    <a href="https://www.klemforge.com/app.html"
      style="font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#000000;text-decoration:none;letter-spacing:2px;text-transform:uppercase;display:block">OPEN FORGE</a>
  </td></tr>
  </table>
  <div style="text-align:center;margin-top:14px;font-family:'Courier New',Courier,monospace;font-size:10px;color:#666;letter-spacing:1.5px;text-transform:uppercase">7-day free trial &nbsp;·&nbsp; no card charged &nbsp;·&nbsp; cancel anytime</div>
</td></tr>

<!-- FOOTER -->
<tr><td style="padding:40px 24px 36px;border-top:1px solid #1a1a1a;margin-top:40px;text-align:center">
  <div style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#666;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px">FORGE · AI Performance Coach</div>
  <div style="font-family:'Courier New',Courier,monospace;font-size:10px;color:#e8ff3d;letter-spacing:1px;margin-bottom:10px"><a href="https://www.klemforge.com" style="color:#e8ff3d;text-decoration:none">klemforge.com</a></div>
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;color:#666">You received this because you signed up for FORGE.</div>
</td></tr>

</table>
</td></tr>
</table>

</body>
</html>`
    ).catch(() => {});

    // Return success — user must confirm email before logging in
    res.json({ requires_confirmation: true, email });
  } catch (err) {
    console.error('Signup error:', err);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PASSWORD RESET REQUEST ──────────────────────
app.post('/api/reset-password', resetLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: process.env.FRONTEND_URL + '?reset=true'
    });
    // Always return success — don't reveal if email exists or not
    if (error) console.error('Reset password error:', error.message);
    res.json({ success: true });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GENERATE PLAN ──────────────────────────────
app.post('/api/generate-plan', requireAuth, async (req, res) => {
  // Keep connection alive during long generation — Railway times out at 60s
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send a heartbeat comment every 20 seconds to prevent proxy timeout
  const heartbeat = setInterval(() => {
    try { res.write(''); } catch(e) { clearInterval(heartbeat); }
  }, 20000);

  const sendResponse = (status, data) => {
    clearInterval(heartbeat);
    res.status(status).end(JSON.stringify(data));
  };

  try {
    // `let` so we can reassign `profile` after a self-heal upsert below — the rest of the
    // function reads `profile` whether it already existed or was just created.
    let { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select(PLAN_PROFILE_FIELDS) // only the fields buildPlanPrompt reads — not all 30+ columns
      .eq('id', req.user.id)
      .maybeSingle();

    if (profileErr) {
      console.error('Profile fetch error:', profileErr.message);
      return sendResponse(500, { error: 'Internal server error' });
    }

    if (!profile) {
      // Profile row missing — create it now as a fallback (self-heal) instead of 404ing.
      const { error: upsertErr } = await supabase
        .from('profiles')
        .upsert({
          id: req.user.id,
          name: req.user.email?.split('@')[0] || '',
          subscription_tier: 'iron',
          subscription_status: 'trial',
          trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString()
        // FIX 2: ignoreDuplicates so a transient read-miss on an EXISTING profile can't
        // overwrite a real trial_ends_at / paid status with a fresh 7-day trial. On conflict
        // this becomes a no-op and the re-fetch below picks up the true row.
        }, { onConflict: 'id', ignoreDuplicates: true });

      if (upsertErr) {
        console.error('Profile create error:', upsertErr.message);
        return sendResponse(500, { error: 'Internal server error' });
      }

      // Re-fetch after creating, then continue with the same `profile` variable below.
      const { data: newProfile, error: refetchErr } = await supabase
        .from('profiles')
        .select(PLAN_PROFILE_FIELDS)
        .eq('id', req.user.id)
        .maybeSingle();

      if (refetchErr || !newProfile) {
        return sendResponse(500, { error: 'Internal server error' });
      }
      profile = newProfile;
    }

    // ── TRIAL BACKSTOP (FIX 2) ────────────────────────────────────────────────
    // New-user race: the profile row can be created by the DB trigger before the signup
    // handler's trial_ends_at write lands (or if that write failed), leaving trial_ends_at
    // NULL — which made some brand-new users see "trial ended" on first load. Set a fresh
    // 7-day trial ONLY when trial_ends_at is NULL and the account is still a trial (or has no
    // status yet). We deliberately do NOT touch a trial_ends_at that is merely in the past —
    // that is a legitimately ENDED trial, and re-granting it would bypass the paywall (see the
    // loadSubscription entitlement guard).
    try {
      const { data: trialCheck } = await supabase
        .from('profiles')
        .select('trial_ends_at, subscription_status')
        .eq('id', req.user.id)
        .maybeSingle();
      if (trialCheck && !trialCheck.trial_ends_at &&
          (!trialCheck.subscription_status || trialCheck.subscription_status === 'trial')) {
        await supabase.from('profiles')
          .update({
            trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            subscription_status: 'trial',
            subscription_tier: 'iron'
          })
          .eq('id', req.user.id);
      }
    } catch (e) { console.error('Trial backstop check failed:', e.message); }

    console.log('=== GENERATE PLAN START ===');
    console.log('User:', profile.name, '| goal:', profile.goal, '| language:', req.body?.language);
    console.log('ANTHROPIC_API_KEY set:', !!process.env.ANTHROPIC_API_KEY);
    console.log('SUPABASE_URL set:', !!process.env.SUPABASE_URL);

    const language = req.body?.language || 'en';

    // Fetch MuscleWiki exercise list to inject into prompt
    const mwExercises = await getMuscleWikiExercises();
    const prompt = buildPlanPrompt(profile, language, mwExercises);

    // Try up to 2 times in case of JSON parse failure
    let plan = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Attempt ${attempt}: calling Anthropic...`);
        const message = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          messages: [{ role: 'user', content: prompt }]
        });
        const raw = message.content[0].text;
        console.log(`Attempt ${attempt}: Anthropic responded, length:`, raw.length);

        // Strip markdown fences
        let clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        // Find outermost { }
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON object found in response');
        clean = clean.substring(start, end + 1);

        plan = JSON.parse(clean);

        // Validate plan has required fields
        if (!plan.workout?.days?.length) throw new Error('Plan missing workout days');
        if (!plan.nutrition?.meals?.length) throw new Error('Plan missing nutrition meals');

        // Remap all exercise names to exact MuscleWiki names
        // This is the mandatory gate — every exercise must map to MuscleWiki
        if (mwExercises && plan.workout?.days) {
          for (const day of plan.workout.days) {
            for (const ex of (day.exercises || [])) {
              // Check exact match first
              const exactMatch = mwExercises.find(e => e.name.toLowerCase() === ex.name.toLowerCase());
              if (exactMatch) {
                ex.name = exactMatch.name; // normalise capitalisation
                ex.mw_id = exactMatch.id;  // Option 3: store MuscleWiki ID
                continue;
              }
              // Not an exact match — resolve via manual map / AI
              const mwName = await resolveExerciseName(ex.name, mwExercises);
              if (mwName) {
                const mwEx = mwExercises.find(e => e.name === mwName);
                ex.name = mwName;
                if (mwEx) ex.mw_id = mwEx.id; // Option 3: store ID
              }
              // If still no match, leave as-is — search will handle it at lookup time
            }
          }
        }

        break; // success
      } catch (err) {
        console.error(`Attempt ${attempt} failed:`, err.message);
        lastError = err;
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!plan) {
      return sendResponse(500, { error: 'Failed to generate plan — please try again', detail: lastError?.message });
    }

    // Delete any existing plan for this user first (clean slate)
    console.log('Deleting existing plan...');
    await supabase.from('plans').delete().eq('user_id', req.user.id);

    // Save to DB — reset translations cache, store source language
    console.log('Inserting new plan...');
    const { data, error } = await supabase
      .from('plans')
      .insert({ user_id: req.user.id, workout_plan: plan.workout, nutrition_plan: plan.nutrition, translations: {}, source_language: language || 'en' })
      .select()
      .maybeSingle();

    if (error) {
      console.error('DB insert error:', error.message, error.details, error.hint);
      throw error;
    }
    console.log('Plan saved to DB successfully');

    // Also save to programmes table (deactivate existing, add new active one)
    const planName = `${profile?.goal || 'My'} Plan — ${new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
    await supabase.from('programmes').update({ is_active: false }).eq('user_id', req.user.id);
    const { data: obProg } = await supabase.from('programmes').insert({
      user_id: req.user.id,
      name: planName,
      plan_data: { workout: plan.workout, nutrition: plan.nutrition },
      is_active: true
    }).select('id').maybeSingle();
    // One-line AI description for the My Programmes list — async, doesn't block onboarding.
    if (obProg?.id) {
      generateProgrammeDescription(obProg.id, {
        goal: Array.isArray(profile?.goal) ? profile.goal.join(', ') : String(profile?.goal || ''),
        days_per_week: profile?.days_per_week,
        experience: profile?.experience,
        day_labels: plan.workout?.days?.map(d => d.label),
      });
    }

    // Mark onboarding complete
    await supabase.from('profiles').update({ onboarding_complete: true }).eq('id', req.user.id);

    console.log('Plan generated successfully for:', profile.name);
    sendResponse(200, { plan: data });
  } catch (err) {
    console.error('Generate plan error:', err.message);
    sendResponse(500, { error: 'Failed to generate plan — please try again', detail: err.message });
  }
});

// ── TRANSLATE PLAN ─────────────────────────────
// ── LANGUAGE HELPERS ───────────────────────────────────────────────────────
const LANG_NAMES = {
  es:'Spanish', fr:'French', de:'German', it:'Italian', pt:'Portuguese',
  nl:'Dutch', uk:'Ukrainian', fi:'Finnish', ar:'Arabic',
  'zh':'Chinese (Simplified)', ja:'Japanese'
};
const SUPPORTED_LANGS = new Set(['en','es','fr','de','it','pt','nl','uk','fi','ar','zh','ja']);

function normalizeLang(code) {
  if (!code) return 'en';
  const c = String(code).toLowerCase().trim();
  return SUPPORTED_LANGS.has(c) ? c : 'en';
}

async function translatePlanText(workout, nutrition, lang) {
  const langName = LANG_NAMES[lang] || lang;

  // Collect ALL food names including weekly_meals overrides
  const baseFoodNames = (nutrition?.meals || []).flatMap(m => (m.foods || []).map(f => f.name || ''));
  const baseMealNames = (nutrition?.meals || []).map(m => m.name || '');

  // weekly_meals is a map of dayIndex -> meals array (per-day overrides)
  const weeklyMealNames = {};
  const weeklyFoodNames = {};
  if (nutrition?.weekly_meals) {
    Object.entries(nutrition.weekly_meals).forEach(([dayIdx, meals]) => {
      if (!Array.isArray(meals)) return;
      weeklyMealNames[dayIdx] = meals.map(m => m.name || '');
      weeklyFoodNames[dayIdx] = meals.flatMap(m => (m.foods || []).map(f => f.name || ''));
    });
  }

  const toTranslate = {
    split_name: workout?.split_name || '',
    split_description: workout?.split_description || '',
    strategy: nutrition?.strategy || '',
    days: (workout?.days || []).map(d => ({
      day_name: d.day_name || '',
      label: d.label || '',
      muscles: d.muscles || [],
      exercise_notes: (d.exercises || []).map(e => e.note || ''),
    })),
    meal_names: baseMealNames,
    food_names: baseFoodNames,
    weekly_meal_names: weeklyMealNames,
    weekly_food_names: weeklyFoodNames,
  };

  const prompt = `Translate the following fitness plan text fields from English into ${langName}.
Rules:
- Keep exercise names (e.g. "Barbell Bench Press", "Squat") in English — universal gym terms
- Translate everything else: day names, labels, muscle names, exercise notes, meal names, food ingredient names, nutrition strategy
- Food names like "Chicken Breast", "Whole Eggs", "Greek Yogurt", "Brown Rice" MUST be translated
- Keep all numbers, units (kg, g, kcal, min), time formats exactly as-is
- Return ONLY valid JSON matching the exact same structure, no explanation, no markdown

Input JSON:
${JSON.stringify(toTranslate, null, 2)}`;

  const aiRes = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = aiRes.content[0]?.text || '';
  const clean = text.replace(/```json\n?|```/g, '').trim();

  let translated;
  try {
    translated = JSON.parse(clean);
  } catch (parseErr) {
    console.error(`Translation JSON parse failed for lang=${lang}, retrying with food names only`);
    // Retry with just the food/meal names to keep it small
    const retryPayload = {
      meal_names: toTranslate.meal_names,
      food_names: toTranslate.food_names,
      weekly_meal_names: toTranslate.weekly_meal_names,
      weekly_food_names: toTranslate.weekly_food_names,
      split_name: toTranslate.split_name,
      split_description: toTranslate.split_description,
      strategy: toTranslate.strategy,
    };
    const retryRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{ role: 'user', content: `Translate into ${langName}. Return ONLY valid JSON, same structure:\n${JSON.stringify(retryPayload)}` }],
    });
    const retryText = retryRes.content[0]?.text || '';
    translated = JSON.parse(retryText.replace(/```json\n?|```/g, '').trim());
    // For the retry, skip day translations (workout part)
    translated.days = [];
  }

  // Apply translations back to deep clones
  const newPlan = JSON.parse(JSON.stringify(workout));
  const newNutrition = JSON.parse(JSON.stringify(nutrition));

  if (translated.split_name) newPlan.split_name = translated.split_name;
  if (translated.split_description) newPlan.split_description = translated.split_description;
  if (translated.strategy && newNutrition) newNutrition.strategy = translated.strategy;

  (translated.days || []).forEach((td, i) => {
    if (!newPlan.days?.[i]) return;
    if (td.day_name) newPlan.days[i].day_name = td.day_name;
    if (td.label) newPlan.days[i].label = td.label;
    if (td.muscles?.length) newPlan.days[i].muscles = td.muscles;
    (td.exercise_notes || []).forEach((note, j) => {
      if (newPlan.days[i].exercises?.[j] && note) newPlan.days[i].exercises[j].note = note;
    });
  });

  // Apply base meal + food name translations
  const mealNames = translated.meal_names || [];
  const foodNames = translated.food_names || [];
  let foodIdx = 0;
  (newNutrition?.meals || []).forEach((meal, mi) => {
    if (mealNames[mi]) meal.name = mealNames[mi];
    (meal.foods || []).forEach(food => {
      if (foodNames[foodIdx]) food.name = foodNames[foodIdx];
      foodIdx++;
    });
  });

  // Apply weekly_meals translations
  if (newNutrition?.weekly_meals && translated.weekly_meal_names) {
    Object.entries(translated.weekly_meal_names).forEach(([dayIdx, tMealNames]) => {
      const tFoodNames = translated.weekly_food_names?.[dayIdx] || [];
      const dayMeals = newNutrition.weekly_meals[dayIdx];
      if (!Array.isArray(dayMeals)) return;
      let wFoodIdx = 0;
      dayMeals.forEach((meal, mi) => {
        if (tMealNames[mi]) meal.name = tMealNames[mi];
        (meal.foods || []).forEach(food => {
          if (tFoodNames[wFoodIdx]) food.name = tFoodNames[wFoodIdx];
          wFoodIdx++;
        });
      });
    });
  }

  return { workout_plan: newPlan, nutrition_plan: newNutrition };
}

// Cache version — increment this to force all cached translations to be rebuilt
const TRANSLATION_CACHE_VERSION = 2;

async function getPlanForLanguage(planRow, lang) {
  // Check server-side translation cache
  const cached = planRow.translations?.[lang];

  if (cached?.workout_plan && cached?.nutrition_plan) {
    // Invalidate old caches by version number
    if (cached._v === TRANSLATION_CACHE_VERSION) {
      return { workout_plan: cached.workout_plan, nutrition_plan: cached.nutrition_plan };
    }
    console.log(`Cache for lang=${lang} is version ${cached._v || 1}, current is ${TRANSLATION_CACHE_VERSION} — re-translating...`);
  }

  if (lang === 'en') {
    const sourceLang = planRow.source_language || 'en';
    if (sourceLang === 'en') {
      return { workout_plan: planRow.workout_plan, nutrition_plan: planRow.nutrition_plan };
    }
    const translated = await translatePlanText(planRow.workout_plan, planRow.nutrition_plan, 'en');
    const entry = { ...translated, _v: TRANSLATION_CACHE_VERSION };
    const translations = { ...(planRow.translations || {}), en: entry };
    await supabase.from('plans').update({ translations }).eq('id', planRow.id);
    return translated;
  }

  const translated = await translatePlanText(planRow.workout_plan, planRow.nutrition_plan, lang);
  const entry = { ...translated, _v: TRANSLATION_CACHE_VERSION };
  const translations = { ...(planRow.translations || {}), [lang]: entry };
  await supabase.from('plans').update({ translations }).eq('id', planRow.id);
  return translated;
}

// ── TRANSLATE PLAN (thin wrapper) ──────────────────────────────────────────
app.post('/api/translate-plan', requireAuth, async (req, res) => {
  try {
    const lang = normalizeLang(req.body.language);
    if (lang === 'en') return res.json({ ok: true, skipped: true });

    const { data: planRow } = await supabase
      .from('plans')
      .select('*')
      .eq('user_id', req.user.id)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!planRow) return res.status(404).json({ error: 'No plan found' });

    const result = await getPlanForLanguage(planRow, lang);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('translate-plan error:', err);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET PLAN ───────────────────────────────────
app.get('/api/plan', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .eq('user_id', req.user.id)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) return res.json({ plan: null });

    const lang = normalizeLang(req.query.lang);
    let workout_plan = data.workout_plan;
    let nutrition_plan = data.nutrition_plan;

    // Always go through getPlanForLanguage — even for English.
    // This handles plans that were originally generated in a non-English language
    // by back-translating them to English via the translations cache.
    try {
      const translated = await getPlanForLanguage(data, lang);
      workout_plan = translated.workout_plan;
      nutrition_plan = translated.nutrition_plan;
    } catch (e) {
      console.error('Plan translation error, falling back to stored plan:', e.message);
      // Keep the stored plan as fallback
    }

    // Strip translations blob — never send to client
    const { translations, ...planWithoutCache } = data;
    res.json({ plan: { ...planWithoutCache, workout_plan, nutrition_plan } });
  } catch (err) {
    console.error('Get plan error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET PROFILE ────────────────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .maybeSingle();

    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── UPDATE PROFILE ─────────────────────────────
app.patch('/api/profile', requireAuth, async (req, res) => {
  try {
    // Only update columns that exist in the schema — ignore unknowns
    const allowed = ['name','age','sex','height_cm','weight_kg','goal','experience',
      'days_per_week','preferred_days','equipment','diet_style','diet_restrictions',
      'injuries','target_weight_kg','onboarding_complete','preferred_language','units',
      'enabled_features','session_duration_mins','session_duration_varies','session_duration_by_day',
      'reminder_time','reminder_timezone'];
    const update = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    // Units may only be 'kg' or 'lbs' — drop anything else so a bad value can't persist.
    if (update.units !== undefined && update.units !== 'kg' && update.units !== 'lbs') delete update.units;
    // session_duration_by_day must be a plain object (e.g. { monday: 60 }) or null — drop
    // anything else so a bad value can't poison the jsonb column.
    if (update.session_duration_by_day !== undefined &&
        update.session_duration_by_day !== null &&
        (typeof update.session_duration_by_day !== 'object' || Array.isArray(update.session_duration_by_day))) {
      delete update.session_duration_by_day;
    }
    // session_duration_varies is a boolean.
    if (update.session_duration_varies !== undefined) update.session_duration_varies = !!update.session_duration_varies;
    // session_duration_mins is an int — drop a non-numeric value rather than persist NaN.
    if (update.session_duration_mins !== undefined) {
      const n = parseInt(update.session_duration_mins, 10);
      if (isNaN(n)) delete update.session_duration_mins; else update.session_duration_mins = n;
    }
    // enabled_features must be an array of strings — drop anything else so a bad value
    // can't poison the jsonb column. (Validated here, not just trusted from the client.)
    if (update.enabled_features !== undefined &&
        !(Array.isArray(update.enabled_features) && update.enabled_features.every(f => typeof f === 'string'))) {
      delete update.enabled_features;
    }

    const { data, error } = await supabase
      .from('profiles')
      .upsert({ id: req.user.id, ...update }, { onConflict: 'id' })
      .select()
      .maybeSingle();

    if (error) {
      // If error is about a column the DB doesn't have yet (preferred_days, units, or
      // enabled_features not migrated), retry without it so the rest of the update still lands.
      if (error.message?.includes('preferred_days') || error.message?.includes('units') || error.message?.includes('enabled_features') || error.message?.includes('session_duration') || error.message?.includes('reminder_')) {
        delete update.preferred_days;
        delete update.units;
        delete update.enabled_features;
        delete update.session_duration_mins;
        delete update.session_duration_varies;
        delete update.session_duration_by_day;
        delete update.reminder_time;
        delete update.reminder_timezone;
        const { data: data2, error: err2 } = await supabase
          .from('profiles').update(update).eq('id', req.user.id).select().maybeSingle();
        if (err2) throw err2;
        return res.json({ profile: data2 });
      }
      throw error;
    }
    res.json({ profile: data });
  } catch (err) {
    console.error('Profile update error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── AI CHAT (with plan editing capability) ─────
app.post('/api/chat', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { messages, context, language } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'No messages' });

    // Check Iron message limit (20/month) — use actual tier not accessTier
    const { isExempt } = req.subscription;
    const checkTier = req.subscription?.tier || 'iron';
    if (!isExempt && !hasAccess('unlimited_coach', checkTier, false)) {
      const usage = await getCoachUsage(req.user.id);
      if (usage >= 20) {
        return res.status(403).json({
          error: 'message_limit_reached',
          message: 'You have used all 20 AI coach messages this month. Upgrade to Steel for unlimited coaching.',
          usage,
          limit: 20
        });
      }
    }

    // Cap message content length to prevent abuse
    const sanitised = messages.slice(-20).map(m => ({ ...m, content: String(m.content || '').slice(0, 2000) }));

    const [{ data: profile }, { data: planData }] = await Promise.all([
      supabase.from('profiles').select(COACH_PROFILE_FIELDS).eq('id', req.user.id).maybeSingle(),
      // PLAN_CORE_FIELDS skips the heavy `translations` cache the coach prompt never reads
      supabase.from('plans').select(PLAN_CORE_FIELDS).eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).maybeSingle()
    ]);

    const { data: recentHistory } = await supabase
      .from('exercise_history')
      .select(HISTORY_PROMPT_FIELDS)
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: false })
      .limit(20);

    let activeProgramme = null;
    try {
      const { data: _ap } = await supabase.from('programmes').select('name, plan_data').eq('user_id', req.user.id).eq('is_active', true).maybeSingle();
      if (_ap && _ap.name) activeProgramme = { name: _ap.name, goal: (_ap.plan_data && (_ap.plan_data.goal || (_ap.plan_data.workout && _ap.plan_data.workout.goal))) || (profile && profile.goal) || null };
    } catch(e) { /* programme context is best-effort */ }
    const systemPrompt = buildCoachPrompt(profile, planData, recentHistory, context, language, activeProgramme);

    // Retry up to 3 times on 529 overloaded errors
    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 6000,
          system: systemPrompt,
          messages: sanitised
        });
        break; // success
      } catch(apiErr) {
        const is529 = apiErr.status === 529 || apiErr.message?.includes('529') || apiErr.message?.includes('overloaded');
        if (is529 && attempt < 3) {
          await new Promise(r => setTimeout(r, 1500 * attempt)); // 1.5s, 3s
          continue;
        }
        throw apiErr; // rethrow if not 529 or final attempt
      }
    }

    const rawReply = response.content[0].text;

    // Extract ALL plan update tags (there could be multiple)
    const planUpdateMatches = [...rawReply.matchAll(/<PLAN_UPDATE>([\s\S]*?)<\/PLAN_UPDATE>/g)];
    let planUpdate = null;
    let cleanReply = rawReply.replace(/<PLAN_UPDATE>[\s\S]*?<\/PLAN_UPDATE>/g, '').trim();

    if (planUpdateMatches.length > 0 && planData) {
      // Fetch the absolute latest plan from DB (not from earlier Promise.all)
      const { data: freshPlan } = await supabase
        .from('plans').select(PLAN_CORE_FIELDS).eq('user_id', req.user.id)
        .order('generated_at', { ascending: false }).limit(1).maybeSingle();

      const currentPlan = {
        workout: freshPlan?.workout_plan || planData.workout_plan,
        nutrition: freshPlan?.nutrition_plan || planData.nutrition_plan
      };

      for (const match of planUpdateMatches) {
        try {
          const updateInstruction = JSON.parse(match[1].trim());
          const updatedPlan = applyPlanUpdate(currentPlan, updateInstruction);
          currentPlan.workout = updatedPlan.workout;
          currentPlan.nutrition = updatedPlan.nutrition;
          planUpdate = { type: updateInstruction.type, summary: updateInstruction.summary };
        } catch(e) {
          console.error('Plan update parse error:', e.message);
          console.error('Raw tag content:', match[1].substring(0, 300));
        }
      }

      if (planUpdate) {
        await supabase.from('plans')
          .update({
            workout_plan: currentPlan.workout,
            nutrition_plan: currentPlan.nutrition,
            generated_at: new Date().toISOString(),
            translations: {} // reset cache — next fetch re-translates
          })
          .eq('id', (freshPlan || planData).id);
      }
    }

    // Track usage for Iron tier users — use actual tier not accessTier
    // accessTier is 'forge' during trial which would skip tracking entirely
    const actualTier = req.subscription?.tier || 'iron';
    const isExemptUser = req.subscription?.isExempt || false;
    if (!isExemptUser && !hasAccess('unlimited_coach', actualTier, false)) {
      await incrementCoachUsage(req.user.id);
    }

    res.json({ reply: cleanReply, plan_update: planUpdate });
  } catch (err) {
    console.error('Chat error:', err.message);
    console.error('Chat stack:', err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── APPLY PLAN UPDATE ──────────────────────────
function applyPlanUpdate(plan, instruction) {
  const updated = JSON.parse(JSON.stringify(plan)); // deep clone

  if (instruction.type === 'swap_exercise') {
    // { type: 'swap_exercise', day_index: 0, old_exercise: 'Bench Press', new_exercise: {...} }
    const day = updated.workout?.days?.find(d => d.day_index === instruction.day_index);
    if (day) {
      const exIdx = day.exercises.findIndex(e =>
        e.name.toLowerCase().includes(instruction.old_exercise.toLowerCase())
      );
      if (exIdx !== -1) day.exercises[exIdx] = instruction.new_exercise;
    }
  }

  if (instruction.type === 'update_exercise') {
    // { type: 'update_exercise', day_index: 0, exercise_name: 'Bench Press', changes: {sets:'5', reps:'3-5'} }
    const day = updated.workout?.days?.find(d => d.day_index === instruction.day_index);
    if (day) {
      const ex = day.exercises.find(e =>
        e.name.toLowerCase().includes(instruction.exercise_name.toLowerCase())
      );
      if (ex) Object.assign(ex, instruction.changes);
    }
  }

  if (instruction.type === 'update_nutrition') {
    Object.assign(updated.nutrition, instruction.changes);
  }

  if (instruction.type === 'update_meal') {
    // Update a meal in the default meal plan
    if (updated.nutrition?.meals?.[instruction.meal_index]) {
      Object.assign(updated.nutrition.meals[instruction.meal_index], instruction.changes);
    }
  }

  if (instruction.type === 'update_weekly_meals') {
    // Set different meals for specific days of the week
    // instruction.weekly_meals: { "0": [...meals], "1": [...meals], ... } keyed by day_index
    // instruction.day_index + instruction.meals: set meals for a single day
    if (!updated.nutrition.weekly_meals) updated.nutrition.weekly_meals = {};

    if (instruction.weekly_meals) {
      // Bulk update multiple days at once
      Object.assign(updated.nutrition.weekly_meals, instruction.weekly_meals);
    } else if (instruction.day_index !== undefined && instruction.meals) {
      // Single day update
      updated.nutrition.weekly_meals[String(instruction.day_index)] = instruction.meals;
    }
  }

  if (instruction.type === 'update_day') {
    // Full day replacement
    const day = updated.workout?.days?.find(d => d.day_index === instruction.day_index);
    if (day) day.exercises = instruction.exercises;
  }

  if (instruction.type === 'reschedule_days') {
    if (instruction.mapping && updated.workout?.days) {
      const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

      // Validate: no double-booking — check for conflicts first
      const finalPositions = {};
      updated.workout.days.forEach(d => { finalPositions[d.day_index] = d.label; });

      // Apply moves to finalPositions map
      const moves = instruction.mapping;
      const movedFrom = new Set(moves.map(m => m.from_day_index));
      
      moves.forEach(m => {
        const label = finalPositions[m.from_day_index];
        if (label) {
          // Vacate the from slot
          delete finalPositions[m.from_day_index];
          // If something is already at to_day_index and it wasn't moved, swap it back
          if (finalPositions[m.to_day_index] && !movedFrom.has(m.to_day_index)) {
            finalPositions[m.from_day_index] = finalPositions[m.to_day_index];
          }
          finalPositions[m.to_day_index] = label;
        }
      });

      // Apply finalPositions back to the days array
      const labelToDay = {};
      updated.workout.days.forEach(d => { labelToDay[d.label] = d; });

      Object.entries(finalPositions).forEach(([idx, label]) => {
        const day = labelToDay[label];
        if (day) {
          day.day_index = parseInt(idx, 10);
          day.day_name = dayNames[parseInt(idx, 10)] || day.day_name;
        }
      });

      // Sort by new day_index
      updated.workout.days.sort((a, b) => a.day_index - b.day_index);
    }
  }

  if (instruction.type === 'replace_entire_plan') {
    // Completely replaces the entire workout plan
    if (instruction.workout) updated.workout = instruction.workout;
    if (instruction.nutrition) updated.nutrition = instruction.nutrition;
  }

  if (instruction.type === 'replace_workout_plan') {
    // Replaces entire workout plan only
    if (instruction.workout) updated.workout = instruction.workout;
  }

  if (instruction.type === 'replace_nutrition_plan') {
    // Replaces entire nutrition plan only
    if (instruction.nutrition) updated.nutrition = instruction.nutrition;
  }

  if (instruction.type === 'add_day') {
    // Adds a new training day
    if (!updated.workout) updated.workout = { days: [] };
    if (!updated.workout.days) updated.workout.days = [];
    updated.workout.days.push(instruction.day);
    updated.workout.days.sort((a, b) => a.day_index - b.day_index);
  }

  if (instruction.type === 'remove_day') {
    // Removes a training day by day_index
    if (updated.workout?.days) {
      updated.workout.days = updated.workout.days.filter(d => d.day_index !== instruction.day_index);
    }
  }

  if (instruction.type === 'update_goals') {
    // Updates the plan's goals/objectives metadata
    if (updated.workout) {
      if (instruction.goal) updated.workout.goal = instruction.goal;
      if (instruction.experience) updated.workout.experience = instruction.experience;
      if (instruction.days_per_week !== undefined) updated.workout.days_per_week = instruction.days_per_week;
      if (instruction.split_type) updated.workout.split_type = instruction.split_type;
    }
  }

  return updated;
}

// ── POST-WORKOUT CHECK-IN ──────────────────────
app.post('/api/checkin', requireAuth, async (req, res) => {
  try {
    // If this user's coach has disabled post-workout check-ins, skip silently
    // and tell the client there's nothing to show.
    if (await isReviewDisabledByCoach(req.user.id, 'post_workout_checkin_enabled')) {
      return res.json({ disabled: true });
    }

    const { session_summary, feeling, difficulty, messages, language } = req.body;

    const [{ data: profile }, { data: planData }] = await Promise.all([
      supabase.from('profiles').select(COACH_PROFILE_FIELDS).eq('id', req.user.id).maybeSingle(),
      // PLAN_CORE_FIELDS skips the heavy `translations` cache the checkin prompt never reads
      supabase.from('plans').select(PLAN_CORE_FIELDS).eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).maybeSingle()
    ]);

    const { data: recentHistory } = await supabase
      .from('exercise_history').select(HISTORY_PROMPT_FIELDS).eq('user_id', req.user.id)
      .order('logged_at', { ascending: false }).limit(10);

    const systemPrompt = buildCheckinPrompt(profile, planData, recentHistory, session_summary, feeling, difficulty, language);

    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: systemPrompt,
          messages: messages || [{ role: 'user', content: `I just finished training. Feeling: ${feeling}. Difficulty: ${difficulty}.` }]
        });
        break;
      } catch(apiErr) {
        const is529 = apiErr.status === 529 || apiErr.message?.includes('529') || apiErr.message?.includes('overloaded');
        if (is529 && attempt < 3) { await new Promise(r => setTimeout(r, 1500 * attempt)); continue; }
        throw apiErr;
      }
    }

    const rawReply = response.content[0].text;
    const planUpdateMatch = rawReply.match(/<PLAN_UPDATE>([\s\S]*?)<\/PLAN_UPDATE>/);
    let planUpdate = null;
    let cleanReply = rawReply.replace(/<PLAN_UPDATE>[\s\S]*?<\/PLAN_UPDATE>/g, '').trim();

    if (planUpdateMatch && planData) {
      try {
        const updateInstruction = JSON.parse(planUpdateMatch[1].trim());
        const currentPlan = { workout: planData.workout_plan, nutrition: planData.nutrition_plan };
        const updatedPlan = applyPlanUpdate(currentPlan, updateInstruction);
        await supabase.from('plans').update({
          workout_plan: updatedPlan.workout,
          nutrition_plan: updatedPlan.nutrition,
          generated_at: new Date().toISOString(),
          translations: {} // reset cache — next fetch re-translates
        }).eq('id', planData.id);
        planUpdate = { type: updateInstruction.type, summary: updateInstruction.summary };
      } catch(e) {
        console.error('Checkin plan update error:', e.message);
      }
    }

    // Track usage for Iron tier users — use actual tier not accessTier
    // accessTier is 'forge' during trial which would skip tracking entirely
    const actualTier = req.subscription?.tier || 'iron';
    const isExemptUser = req.subscription?.isExempt || false;
    if (!isExemptUser && !hasAccess('unlimited_coach', actualTier, false)) {
      await incrementCoachUsage(req.user.id);
    }

    res.json({ reply: cleanReply, plan_update: planUpdate });
  } catch (err) {
    console.error('Checkin error:', err.status || '', err.message);
    if (err.message?.includes('overloaded') || err.status === 529) {
      return res.status(503).json({ error: 'AI is busy — please try again in a moment.' });
    }
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── LOG SESSION ────────────────────────────────
app.post('/api/log', requireAuth, async (req, res) => {
  try {
    const { day_index, day_label, exercises } = req.body;
    // Input validation
    if (!Array.isArray(exercises) || exercises.length === 0) return res.status(400).json({ error: 'No exercises provided' });
    if (exercises.length > 30) return res.status(400).json({ error: 'Too many exercises' });
    for (const ex of exercises) {
      const sets = ex.sets_data || [];
      for (const s of sets) {
        if (s.weight < 0 || s.weight > 1000) return res.status(400).json({ error: 'Invalid weight value' });
        if (s.reps < 0 || s.reps > 200) return res.status(400).json({ error: 'Invalid reps value' });
      }
      if (sets.length > 20) return res.status(400).json({ error: 'Too many sets' });
    }
    const today = new Date().toISOString().split('T')[0];

    // Save session log — upsert pattern: delete today's existing entry then insert fresh
    const { error: delError } = await supabase.from('session_logs')
      .delete()
      .eq('user_id', req.user.id)
      .eq('day_index', day_index)
      .gte('logged_at', today)
      .lt('logged_at', today + 'T23:59:59');

    if (delError) console.warn('session_logs delete warning:', delError.message);

    const { error: logError } = await supabase.from('session_logs').insert({
      user_id: req.user.id,
      day_index,
      day_label,
      logged_at: today,
      exercises
    });

    if (logError) {
      console.error('session_logs insert error:', logError.message, logError.details, logError.hint);
      throw logError;
    }

    // ── Batched history + PR writes ──────────────────────────────────────
    // Was N+1: per exercise we ran delete + insert + PR-select + PR-upsert
    // (≈4 sequential round-trips × N exercises). Now: 1 delete + 1 insert +
    // 1 PR-select + 1 PR-upsert total, regardless of exercise count.
    // Per-exercise stats are still computed in JS; only the DB calls are batched.
    // Keyed by exercise_name (last entry wins) to preserve the original
    // delete-then-insert "last write wins" semantics for any duplicate names.
    const historyByName = new Map(); // name -> history row
    const statByName = new Map();     // name -> { bestSet, est1rm, setsLen }
    for (const ex of exercises) {
      // exercises now have a sets_data array: [{weight, reps}, ...]
      // Use best set for PR calculation, total volume across all sets
      const setsData = ex.sets_data || [{ weight: ex.weight, reps: ex.reps }];
      const totalVol = setsData.reduce((sum, s) => sum + (s.weight * s.reps), 0);
      const bestSet = setsData.reduce((best, s) => {
        const e1rm = s.weight * (1 + s.reps / 30);
        return e1rm > (best.weight * (1 + best.reps / 30)) ? s : best;
      }, setsData[0]);
      const est1rm = Math.round(bestSet.weight * (1 + bestSet.reps / 30));

      historyByName.set(ex.name, {
        user_id: req.user.id,
        exercise_name: ex.name,
        logged_at: today,
        weight_kg: bestSet.weight,
        reps: bestSet.reps,
        sets: setsData.length,
        volume: totalVol,
        est_1rm: est1rm,
        sets_data: setsData // store full per-set breakdown
      });
      statByName.set(ex.name, { bestSet, est1rm, setsLen: setsData.length });
    }

    const exerciseNames = [...historyByName.keys()];

    // Replace today's history for these exercises in one delete + one insert
    await supabase.from('exercise_history')
      .delete()
      .eq('user_id', req.user.id)
      .eq('logged_at', today)
      .in('exercise_name', exerciseNames);

    const { error: histErr } = await supabase
      .from('exercise_history')
      .insert([...historyByName.values()]);
    if (histErr) console.warn('exercise_history insert warning:', histErr.message);

    // Fetch all existing PRs for these exercises in one query (was one per exercise)
    const { data: existingPRs } = await supabase
      .from('personal_records')
      .select('exercise_name, est_1rm') // only field used for the PR comparison
      .eq('user_id', req.user.id)
      .in('exercise_name', exerciseNames);

    const prByName = {};
    for (const p of (existingPRs || [])) prByName[p.exercise_name] = p;

    // Decide which exercises are new PRs, then upsert them all at once
    const prUpdates = [];
    const prRows = [];
    for (const name of exerciseNames) {
      const st = statByName.get(name);
      const existing = prByName[name];
      if (!existing || st.est1rm > (existing.est_1rm || 0)) {
        prRows.push({
          user_id: req.user.id,
          exercise_name: name,
          weight_kg: st.bestSet.weight,
          reps: st.bestSet.reps,
          sets: st.setsLen,
          est_1rm: st.est1rm,
          achieved_at: today
        });
        prUpdates.push(name);
      }
    }
    if (prRows.length) {
      await supabase.from('personal_records')
        .upsert(prRows, { onConflict: 'user_id,exercise_name' });
    }

    res.json({ success: true, new_prs: prUpdates });
  } catch (err) {
    console.error('Log error:', err);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET EXERCISE HISTORY ───────────────────────
app.get('/api/history/:exerciseName', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('exercise_history')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('exercise_name', decodeURIComponent(req.params.exerciseName))
      .order('logged_at', { ascending: true })
      .limit(20);

    if (error) throw error;
    res.json({ history: data });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET ALL HISTORY ────────────────────────────
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    // exercise_history grows several rows per session — cap to the most recent 750
    // rows so a long-tenured user can't pull thousands. Fetch newest-first to apply
    // the cap, then reverse to the ascending order the progress charts expect.
    const { data, error } = await supabase
      .from('exercise_history')
      .select('*')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: false })
      .limit(750);

    if (error) throw error;
    res.json({ history: (data || []).reverse() });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET SESSION LOGS ──────────────────────────────
// Returns full session_logs rows (with day_label + exercises jsonb) so the progress
// panel can render workouts grouped by session rather than flattened by exercise.
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    console.log('[sessions] fetching for user:', req.user.id);
    // ROOT CAUSE OF THE 500: this select used to request `feeling, difficulty`, but
    // session_logs has no such columns (schema: id, user_id, day_index, day_label,
    // logged_at, exercises, created_at). feeling/difficulty are only fed to the
    // post-workout check-in AI prompt — they are never persisted. PostgREST then
    // threw "column session_logs.feeling does not exist", the catch returned 500,
    // and the progress panel's session history never refreshed after a workout.
    const { data, error } = await supabase
      .from('session_logs')
      .select('id, logged_at, day_index, day_label, exercises')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: false })
      .limit(limit);
    // Log the count (not the full jsonb payload) plus the error so the cause is
    // visible in Railway logs without flooding them on every progress-panel open.
    console.log('[sessions] query result:', { rows: data?.length ?? 0, error });
    if (error) throw error;
    res.json({ sessions: data || [] });
  } catch (err) {
    console.error('[sessions] error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET PRs ────────────────────────────────────
app.get('/api/prs', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('personal_records')
      .select('exercise_name, weight_kg, reps, sets, est_1rm, achieved_at')
      .eq('user_id', req.user.id)
      .order('achieved_at', { ascending: false })
      .limit(100); // one PR per exercise — 100 is comfortably above any real catalogue

    if (error) throw error;
    res.json({ prs: data });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── SEARCH PRs BY EXERCISE NAME ────────────────
app.get('/api/prs/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ prs: [] });
    // FIX 5: tolerant matching. Normalise the query, split into words, and match ANY word
    // (and its singular/stem) via OR(ilike) so "benchpress" → bench OR press finds "Bench
    // Press", and a plural like "curls" → "curl" finds "Barbell Curl". The frontend has a
    // Levenshtein fallback for typos when this returns nothing.
    const normalised = q.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[^a-z0-9 ]/g, '');
    const words = normalised.split(' ').filter(w => w.length > 1);
    const stemWord = (w) => w.replace(/ies$/, 'y').replace(/ing$/, '').replace(/ed$/, '').replace(/es$/, '').replace(/s$/, '');
    const terms = new Set();
    words.forEach(w => {
      terms.add(w);
      const s = stemWord(w);
      if (s.length >= 3 && s !== w) terms.add(s);
    });
    let prQuery = supabase
      .from('personal_records')
      .select('exercise_name, weight_kg, reps, est_1rm, achieved_at')
      .eq('user_id', req.user.id);
    prQuery = terms.size
      ? prQuery.or([...terms].map(w => `exercise_name.ilike.%${w}%`).join(','))
      : prQuery.ilike('exercise_name', `%${q}%`);
    const { data, error } = await prQuery
      .order('achieved_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ prs: data || [] });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── LOG BODYWEIGHT ─────────────────────────────
app.post('/api/bodyweight', requireAuth, async (req, res) => {
  try {
    const { weight_kg } = req.body;
    const w = parseFloat(weight_kg);
    console.log('[bodyweight] save attempt:', { user_id: req.user.id, weight_kg });
    if (isNaN(w)) return res.status(400).json({ error: 'invalid_weight' });
    const today = new Date().toISOString().split('T')[0];

    // Manual upsert instead of .upsert({ onConflict: 'user_id,logged_at' }) — the
    // onConflict form silently failed (its result was never captured, so the route
    // always returned success even when the write errored, e.g. if the matching
    // unique constraint was missing). Check-then-update/insert needs no DB constraint.
    const { data: existing } = await supabase
      .from('bodyweight_log')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('logged_at', today)
      .maybeSingle();

    let data, error;
    if (existing) {
      ({ data, error } = await supabase
        .from('bodyweight_log')
        .update({ weight_kg: w })
        .eq('id', existing.id)
        .select()
        .maybeSingle());
    } else {
      ({ data, error } = await supabase
        .from('bodyweight_log')
        .insert({ user_id: req.user.id, weight_kg: w, logged_at: today })
        .select()
        .maybeSingle());
    }

    console.log('[bodyweight] save result:', data, error);
    if (error) { console.error('Server error:', error); return res.status(500).json({ error: 'Internal server error' }); }
    res.json({ success: true, entry: data });
  } catch (err) {
    console.error('[bodyweight] save exception:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET STREAK & BADGES ────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    // Intentionally unlimited: lifetime monthly-badge counts and the longest-streak
    // history need every logged day. Selecting only the `logged_at` date column (one
    // small string per session) keeps the payload tiny even for multi-year users.
    const { data: sessions } = await supabase
      .from('session_logs')
      .select('logged_at')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: false });

    // Get existing stats row
    const { data: existingStats } = await supabase
      .from('user_stats')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!sessions?.length) {
      return res.json({ streak: 0, longest_streak: 0, badges: [], monthly_counts: {} });
    }

    // Get unique workout dates sorted descending
    const uniqueDates = [...new Set(sessions.map(s => s.logged_at))].sort().reverse();

    // Compute current streak
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    let streak = 0;
    let checkDate = uniqueDates[0] === today || uniqueDates[0] === yesterday ? uniqueDates[0] : null;

    if (checkDate) {
      for (const date of uniqueDates) {
        if (date === checkDate) {
          streak++;
          const prev = new Date(checkDate);
          prev.setDate(prev.getDate() - 1);
          checkDate = prev.toISOString().split('T')[0];
        } else {
          break;
        }
      }
    }

    const longest_streak = Math.max(streak, existingStats?.longest_streak || 0);

    // Monthly workout counts — count unique days logged per month
    const monthly_counts = {};
    sessions.forEach(s => {
      const month = s.logged_at.substring(0, 7); // "2025-04"
      if (!monthly_counts[month]) monthly_counts[month] = new Set();
      monthly_counts[month].add(s.logged_at);
    });
    // Convert sets to counts
    Object.keys(monthly_counts).forEach(k => {
      monthly_counts[k] = monthly_counts[k].size;
    });

    // Compute badges — one per month where workouts >= 6
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const badges = Object.entries(monthly_counts)
      .filter(([, count]) => count >= 6)
      .map(([month]) => {
        const [year, m] = month.split('-');
        return {
          id: month,
          month: MONTH_NAMES[parseInt(m) - 1],
          year: parseInt(year),
          label: `${MONTH_NAMES[parseInt(m) - 1]} ${year}`,
          unlocked: true
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    // Upsert stats to DB
    await supabase.from('user_stats').upsert({
      user_id: req.user.id,
      current_streak: streak,
      longest_streak,
      last_workout_date: uniqueDates[0],
      badges,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

    res.json({ streak, longest_streak, badges, monthly_counts });
  } catch (err) {
    console.error('Stats error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET BODYWEIGHT HISTORY ─────────────────────
app.get('/api/bodyweight', requireAuth, async (req, res) => {
  try {
    // bodyweight_log is capped at one row per day, so it is naturally self-bounding.
    // The ascending+limit(1825) (≈5 years) guard keeps the earliest entry — which the
    // chart/summary use as the starting weight — while still capping any runaway read.
    const { data, error } = await supabase
      .from('bodyweight_log')
      .select('weight_kg, logged_at')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: true })
      .limit(1825);

    console.log('[bodyweight] fetch for user:', req.user.id, 'rows:', data?.length);
    if (error) throw error;
    res.json({ history: data });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── BODYWEIGHT HISTORY + SUMMARY ───────────────
// Reads bodyweight_log (the same source as the progress bodyweight card and
// POST /api/bodyweight), NOT body_metrics — body_metrics holds chest/waist/etc
// measurements and would not match what the card shows. logged_at is mapped to
// recorded_at so the frontend contract uses one field name.
app.get('/api/bodyweight/history', requireAuth, async (req, res) => {
  try {
    // Self-bounding (one row/day); ascending+limit(1825) keeps the earliest entry as
    // the starting weight while capping reads at ≈5 years of daily logs.
    const { data, error } = await supabase
      .from('bodyweight_log')
      .select('weight_kg, logged_at')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: true })
      .limit(1825);

    if (error) throw error;

    const history = (data || []).map(r => ({ weight_kg: r.weight_kg, recorded_at: r.logged_at }));

    if (!history.length) {
      return res.json({
        history: [],
        starting_weight: null, current_weight: null,
        total_change: null, lowest_weight: null, highest_weight: null
      });
    }

    const weights = history.map(r => Number(r.weight_kg));
    const starting_weight = history[0].weight_kg;
    const current_weight = history[history.length - 1].weight_kg;
    const change = Number(current_weight) - Number(starting_weight);
    const total_change = (change >= 0 ? '+' : '−') + Math.abs(change).toFixed(1);

    res.json({
      history,
      starting_weight,
      current_weight,
      total_change,
      lowest_weight: Math.min(...weights),
      highest_weight: Math.max(...weights)
    });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PROMPT BUILDERS ────────────────────────────
function buildPlanPrompt(profile, language, mwExercises) {
  const langNames = {en:'English',es:'Spanish',fr:'French',de:'German',it:'Italian',pt:'Portuguese',nl:'Dutch',uk:'Ukrainian',fi:'Finnish',ar:'Arabic',zh:'Chinese',ja:'Japanese'};
  const langName = (language && language !== 'en') ? (langNames[language] || 'English') : 'English';
  // Sanitise all string fields to prevent JSON issues
  const safe = (v, fallback = 'not specified') => String(v || fallback).replace(/["""'']/g, '').substring(0, 200).trim();

  // Session-duration context: tell the AI how long each session should run so it sizes
  // the per-day exercise count and total volume to fit (warm-up + working sets + rest).
  const durationContext = profile.session_duration_varies
    ? `Session durations vary by day (minutes): ${JSON.stringify(profile.session_duration_by_day || {})}`
    : `Each session is approximately ${profile.session_duration_mins || 60} minutes.`;

  return `You are an expert strength and conditioning coach. Generate a completely personalised workout and nutrition plan.

PROFILE:
- Name: ${safe(profile.name, 'User')}
- Age: ${profile.age || 18}, Sex: ${safe(profile.sex, 'male')}
- Height: ${profile.height_cm || 175}cm, Weight: ${profile.weight_kg || 70}kg
- Goal: ${safe(profile.goal, 'muscle')}
- Experience: ${safe(profile.experience, 'intermediate')}
- Training days per week: ${profile.days_per_week || 4}
- Preferred training days: ${safe(profile.preferred_days, 'flexible')}
- Session length: ${durationContext} Size each day's exercise count and total volume to fit the available time (account for warm-up and rest between sets).
- Equipment: ${safe(profile.equipment, 'full_gym')}
- Diet style: ${safe(profile.diet_style, 'anything')}
- Diet restrictions: ${safe(profile.diet_restrictions, 'none')}
- Injuries or limitations: ${safe(profile.injuries, 'none')}${
  profile.injuries && profile.injuries.toLowerCase().includes('sport:')
  ? `\n\nSPORT PERFORMANCE CONTEXT:\nThis athlete plays a sport. Build their gym programme to COMPLEMENT their sport training — not compete with it.\n- Avoid heavy gym sessions on sport training days\n- Prioritise: strength, power, injury prevention, and sport-specific physical qualities\n- Their sport details are embedded in the injuries/notes field above — extract and use them\n- If they have an upcoming competition, periodise accordingly`
  : ''
}

${mwExercises ? `EXERCISE DATABASE — CRITICAL RULE:
You MUST use exercise names EXACTLY as they appear in this list. Copy the name character-for-character. Do NOT paraphrase, abbreviate, or invent names.
If an exercise is not in this list, pick the closest one that IS in the list.
${['Barbell','Dumbbell','Cable','Machine','Bodyweight','Kettlebell'].map(cat => {
  const exs = mwExercises.filter(e => e.category === cat).map(e => e.name).slice(0, 50);
  return exs.length ? cat.toUpperCase() + ': ' + exs.join(' | ') : '';
}).filter(Boolean).join('\n')}
REPEAT: Every exercise "name" field must be copied verbatim from the list above.` : ''}

CRITICAL INSTRUCTIONS:
1. Respond ONLY with a single valid JSON object. No text before or after it.
2. Do NOT use special characters like dashes (use to instead), smart quotes, or em dashes inside string values.
3. Every string value must use only standard ASCII or characters native to the target language.
4. The JSON must be complete and valid - do not truncate it.
5. LANGUAGE: Write ALL human-readable text (exercise names, notes, meal names, food names, strategy, split names, labels, day names) in ${langName}. Keep units (kg, g, kcal, min, AM, PM) standard.

Use EXACTLY this JSON structure:
{
  "workout": {
    "split_name": "PPL x2",
    "split_description": "Push Pull Legs repeated twice per week",
    "days": [
      {
        "day_index": 0,
        "day_name": "Monday",
        "label": "Push A",
        "muscles": ["Chest", "Shoulders", "Triceps"],
        "exercises": [
          {
            "name": "Barbell Bench Press",
            "note": "Full ROM, control the negative",
            "sets": "4",
            "reps": "6-8",
            "rest": "3 min",
            "rpe": 8
          }

        ]
      }
    ]
  },
  "nutrition": {
    "calories": 2950,
    "protein_g": 185,
    "carbs_g": 340,
    "fat_g": 95,
    "strategy": "Caloric surplus for muscle gain",
    "meals": [
      {
        "name": "Meal 1 Breakfast",
        "time": "7:00-8:00 AM",
        "kcal": 680,
        "protein_g": 47,
        "carbs_g": 72,
        "fat_g": 22,
        "foods": [
          { "name": "Whole eggs", "amount": "4 eggs" },
          { "name": "Oats", "amount": "80g" }
        ]
      }
    ],
    "weekly_meals": {
      "0": [
        { "name": "Meal 1 Breakfast", "time": "7:00 AM", "kcal": 680, "protein_g": 47, "carbs_g": 72, "fat_g": 22, "foods": [{ "name": "Whole eggs", "amount": "4 eggs" }, { "name": "Oats", "amount": "80g" }] },
        { "name": "Meal 2 Lunch", "time": "12:30 PM", "kcal": 750, "protein_g": 55, "carbs_g": 85, "fat_g": 20, "foods": [{ "name": "Chicken breast", "amount": "200g" }, { "name": "Rice", "amount": "200g cooked" }] }
      ],
      "1": [
        { "name": "Meal 1 Breakfast", "time": "7:00 AM", "kcal": 650, "protein_g": 45, "carbs_g": 70, "fat_g": 20, "foods": [{ "name": "Greek yogurt", "amount": "250g" }, { "name": "Banana", "amount": "1 large" }] },
        { "name": "Meal 2 Lunch", "time": "12:30 PM", "kcal": 720, "protein_g": 52, "carbs_g": 80, "fat_g": 18, "foods": [{ "name": "Salmon fillet", "amount": "180g" }, { "name": "Sweet potato", "amount": "200g" }] }
      ]
    }
  }
}

CRITICAL NUTRITION INSTRUCTION:
You MUST generate a full weekly_meals object with 7 different daily meal plans (keys "0" through "6" for Monday through Sunday).
Each day must have ALL meals for that day (breakfast, lunch, dinner, snacks as appropriate).
Make each day DIFFERENT — vary the protein sources, carb sources, and meal types throughout the week.
Do NOT repeat the same meals on consecutive days.
The "meals" array is just a fallback — the "weekly_meals" object is what gets displayed.
Keep total daily macros consistent across all 7 days but vary the actual foods.`;
}

function buildCoachPrompt(profile, planData, recentHistory, context, language, activeProgramme) {
  const plan = planData?.workout_plan;
  const nutrition = planData?.nutrition_plan;

  const historyStr = recentHistory?.length
    ? recentHistory.map(h => `${h.exercise_name}: ${h.sets}×${h.reps} @ ${h.weight_kg}kg (${h.logged_at})`).join('\n')
    : 'No sessions logged yet.';

  const fullPlanStr = plan?.days
    ? plan.days.map(d => `[day_index:${d.day_index}] ${d.day_name} — ${d.label}: ${d.exercises?.map(e => `${e.name} ${e.sets}x${e.reps}`).join(', ') || 'Rest'}`).join('\n')
    : 'Not generated';

  const progCtx = (activeProgramme && activeProgramme.name)
    ? `\nACTIVE PROGRAMME: The user is currently following their '${activeProgramme.name}' programme.` + (activeProgramme.goal ? ` Their goal for this programme is ${activeProgramme.goal}.` : '') + ` Coach them in the context of this specific programme and goal. If they ask about switching goals or programmes, acknowledge that they have multiple saved programmes available.`
    : '';
  const contextStr = (context ? `\nCURRENT CONTEXT: ${context}` : '') + progCtx;

  const langNames = { en:'English', es:'Spanish', fr:'French', de:'German', it:'Italian', pt:'Portuguese', nl:'Dutch', uk:'Ukrainian', fi:'Finnish', ar:'Arabic', zh:'Chinese', ja:'Japanese' };
  const langStr = language && language !== 'en'
    ? `\nLANGUAGE: You MUST respond entirely in ${langNames[language] || language}. Every word of your response must be in ${langNames[language] || language}. Do not switch to English under any circumstances.`
    : '';

  return `You are a world-class personal trainer and nutrition coach embedded in the FORGE fitness app. You are coaching a specific client. Be direct, specific, and actionable. No fluff. Use their exact numbers when relevant.${contextStr}${langStr}

CLIENT PROFILE:
- Name: ${profile?.name || 'User'}
- Age: ${profile?.age}, Sex: ${profile?.sex}
- Height: ${profile?.height_cm}cm, Weight: ${profile?.weight_kg}kg
- Goal: ${profile?.goal}
- Experience: ${profile?.experience}
- Training: ${profile?.days_per_week} days/week, ${profile?.equipment}
- Diet: ${profile?.diet_style} — restrictions: ${profile?.diet_restrictions || 'none'}
- Injuries: ${profile?.injuries || 'none'}

FULL WORKOUT PROGRAMME:
${fullPlanStr}

NUTRITION TARGETS:
${nutrition ? `${nutrition.calories} kcal — ${nutrition.protein_g}g protein, ${nutrition.carbs_g}g carbs, ${nutrition.fat_g}g fat` : 'Not yet generated'}

RECENT TRAINING HISTORY:
${historyStr}

YOUR ROLE: Be their coach. Give specific, personalised advice. Reference their actual numbers. Sound like someone who's fully invested in this person's progress.

FULL PLAN EDITING ACCESS — You can change ANYTHING in the plan. Never say you don't have access. Use the <PLAN_UPDATE> tag to make changes. The tag is processed automatically — only your text response is shown to the user.

CURRENT WORKOUT SCHEDULE — LIVE FROM DATABASE (these are the ONLY training days that exist):
${plan?.days ? plan.days.map(d => `  day_index:${d.day_index} = ${d.day_name} → ${d.label || 'Rest'} (${d.exercises?.length || 0} exercises)`).join('\n') : 'Not generated'}

OCCUPIED day_index values: ${plan?.days ? plan.days.filter(d => d.exercises?.length > 0).map(d => d.day_index).join(', ') : 'none'}
FREE day_index values (no workout): ${plan?.days ? [0,1,2,3,4,5,6].filter(i => !plan.days.find(d => d.day_index === i && d.exercises?.length > 0)).join(', ') : '0,1,2,3,4,5,6'}

FULL MEAL PLAN (default — same every day unless overridden below):
${nutrition?.meals ? nutrition.meals.map((m, i) => `  meal_index:${i} = ${m.name} (${m.time}) — ${(m.foods || []).map(f => `${f.name} ${f.amount}`).join(', ')}`).join('\n') : 'Not generated'}

PER-DAY MEAL OVERRIDES (these override the default for specific days):
${nutrition?.weekly_meals && Object.keys(nutrition.weekly_meals).length
  ? Object.entries(nutrition.weekly_meals).map(([dayIdx, meals]) =>
      `  Day ${dayIdx} (${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][parseInt(dayIdx)] || dayIdx}):\n` +
      meals.map((m, i) => `    meal_index:${i} = ${m.name} — ${(m.foods || []).map(f => `${f.name} ${f.amount}`).join(', ')}`).join('\n')
    ).join('\n')
  : '  None set — all days use the default above'}

PLAN UPDATE TYPES — use exactly as shown:

1. MOVE A WORKOUT TO A DIFFERENT DAY:
<PLAN_UPDATE>{"type":"reschedule_days","mapping":[{"from_day_index":0,"to_day_index":4}],"summary":"Moved Monday workout to Friday"}</PLAN_UPDATE>

2. SWAP AN EXERCISE:
<PLAN_UPDATE>{"type":"swap_exercise","day_index":0,"old_exercise":"Bench Press","new_exercise":{"name":"Dumbbell Press","note":"Full ROM","sets":"4","reps":"8-10","rest":"2 min","rpe":8},"summary":"Swapped Bench Press for Dumbbell Press on Monday"}</PLAN_UPDATE>

3. CHANGE EXERCISE SETS/REPS:
<PLAN_UPDATE>{"type":"update_exercise","day_index":0,"exercise_name":"Bench Press","changes":{"sets":"5","reps":"3-5"},"summary":"Updated Bench Press to 5x3-5"}</PLAN_UPDATE>

4. CHANGE NUTRITION MACROS:
<PLAN_UPDATE>{"type":"update_nutrition","changes":{"calories":3100,"protein_g":200,"carbs_g":360,"fat_g":90},"summary":"Updated macros to 3100 kcal"}</PLAN_UPDATE>

5. CHANGE THE DEFAULT MEAL PLAN (affects all days that don't have overrides):
<PLAN_UPDATE>{"type":"update_meal","meal_index":0,"changes":{"name":"Meal 1 Breakfast","time":"7:00 AM","kcal":700,"protein_g":50,"carbs_g":70,"fat_g":20,"foods":[{"name":"Greek yogurt","amount":"200g"},{"name":"Oats","amount":"80g"}]},"summary":"Updated default breakfast"}</PLAN_UPDATE>

6. SET DIFFERENT MEALS FOR A SPECIFIC DAY (use this when user wants different food on certain days):
<PLAN_UPDATE>{"type":"update_weekly_meals","day_index":0,"meals":[{"name":"Meal 1 Breakfast","time":"7:00 AM","kcal":600,"protein_g":45,"carbs_g":60,"fat_g":18,"foods":[{"name":"Scrambled eggs","amount":"3 eggs"},{"name":"Toast","amount":"2 slices"}]},{"name":"Meal 2 Lunch","time":"12:00 PM","kcal":700,"protein_g":50,"carbs_g":80,"fat_g":20,"foods":[{"name":"Chicken breast","amount":"150g"},{"name":"Rice","amount":"200g cooked"}]}],"summary":"Set custom meals for Monday"}</PLAN_UPDATE>

7. SET MEALS FOR MULTIPLE DAYS — send ONE tag per day, NOT one big tag:
<PLAN_UPDATE>{"type":"update_weekly_meals","day_index":0,"meals":[{"name":"Meal 1 Breakfast","time":"7:00 AM","kcal":600,"protein_g":45,"carbs_g":60,"fat_g":18,"foods":[{"name":"Eggs","amount":"3 eggs"},{"name":"Toast","amount":"2 slices"}]},{"name":"Meal 2 Lunch","time":"12:30 PM","kcal":700,"protein_g":50,"carbs_g":80,"fat_g":20,"foods":[{"name":"Chicken","amount":"150g"},{"name":"Rice","amount":"200g"}]}],"summary":"Monday meals"}</PLAN_UPDATE>
<PLAN_UPDATE>{"type":"update_weekly_meals","day_index":1,"meals":[{"name":"Meal 1 Breakfast","time":"7:00 AM","kcal":550,"protein_g":40,"carbs_g":55,"fat_g":16,"foods":[{"name":"Oats","amount":"80g"},{"name":"Protein powder","amount":"1 scoop"}]},{"name":"Meal 2 Lunch","time":"12:30 PM","kcal":650,"protein_g":48,"carbs_g":75,"fat_g":18,"foods":[{"name":"Tuna","amount":"150g"},{"name":"Pasta","amount":"180g cooked"}]}],"summary":"Tuesday meals"}</PLAN_UPDATE>

8. REPLACE ALL EXERCISES ON A DAY:
<PLAN_UPDATE>{"type":"update_day","day_index":0,"exercises":[{"name":"Exercise","note":"cue","sets":"4","reps":"8-10","rest":"2 min","rpe":8}],"summary":"Replaced Monday workout"}</PLAN_UPDATE>

- Add a training day: <PLAN_UPDATE>{"type":"add_day","day":{"day_index":4,"day_name":"Friday","label":"Lower Body B","exercises":[{"name":"Squat","note":"Full depth","sets":"4","reps":"6-8","rest":"3 min","rpe":8}]},"summary":"Added Friday lower body session"}</PLAN_UPDATE>

- Remove a training day: <PLAN_UPDATE>{"type":"remove_day","day_index":4,"summary":"Removed Friday session"}</PLAN_UPDATE>

- Update goals/split: <PLAN_UPDATE>{"type":"update_goals","goal":"hypertrophy","days_per_week":4,"split_type":"Upper/Lower","summary":"Updated to 4-day upper/lower split"}</PLAN_UPDATE>

- Replace entire workout plan: <PLAN_UPDATE>{"type":"replace_workout_plan","workout":{"days_per_week":4,"split_type":"Push/Pull/Legs","goal":"muscle","days":[{"day_index":0,"day_name":"Monday","label":"Push A","exercises":[{"name":"Bench Press","note":"Controlled descent","sets":"4","reps":"6-8","rest":"3 min","rpe":8}]}]},"summary":"Complete new 4-day Push/Pull/Legs programme"}</PLAN_UPDATE>

- Replace entire nutrition plan: <PLAN_UPDATE>{"type":"replace_nutrition_plan","nutrition":{"calories":3000,"protein_g":180,"carbs_g":350,"fat_g":85,"meals":[{"name":"Breakfast","time":"7:00 AM","kcal":700,"protein_g":50,"carbs_g":80,"fat_g":20,"foods":[{"name":"Oats","amount":"80g"},{"name":"Whey protein","amount":"1 scoop"}]}]},"summary":"New nutrition plan at 3000 kcal"}</PLAN_UPDATE>

- Replace entire plan (workout + nutrition): <PLAN_UPDATE>{"type":"replace_entire_plan","workout":{...},"nutrition":{...},"summary":"Complete programme overhaul"}</PLAN_UPDATE>

CRITICAL RULES FOR PLAN EDITING:
- When user asks to change goals, training days, split, or wants a completely different programme — use replace_workout_plan with the full new plan
- When user asks to change calories, macros, or wants a completely new diet — use replace_nutrition_plan
- Never refuse to make changes. Never say you need to regenerate. Just make the change directly.
- Always confirm what you changed in plain language after the PLAN_UPDATE tag
- ONLY OUTPUT ONE <PLAN_UPDATE> TAG PER RESPONSE — never multiple tags for the same action
- Before adding a day, check the existing days in the plan. Do not add a day that already exists at that day_index
- Before removing a day, verify it exists in the plan first
- The plan shown in your context is the current live plan — treat it as ground truth

RULES:
- ALWAYS use the OCCUPIED and FREE day_index lists above — never guess
- NEVER move a workout to an OCCUPIED day_index unless the user specifically asks to swap two days
- If the user asks to move to an occupied day, tell them what's already there and ask if they want to swap
- If the user asks to move to a FREE day, just do it with reschedule_days
- NEVER say you don't have access — you have full access to change everything
- When setting per-day meals, send ONE tag per day — never combine multiple days into one tag
- Each tag's meals array must include ALL meals for that day, not just changed ones
- Always confirm what you changed in plain text after the tags`;
}

function buildCheckinPrompt(profile, planData, recentHistory, sessionSummary, feeling, difficulty, language) {
  const plan = planData?.workout_plan;
  const nutrition = planData?.nutrition_plan;

  const historyStr = recentHistory?.length
    ? recentHistory.map(h => `${h.exercise_name}: ${h.sets}×${h.reps} @ ${h.weight_kg}kg (${h.logged_at})`).join('\n')
    : 'No sessions logged yet.';

  const fullPlanStr = plan?.days
    ? plan.days.map(d => `${d.day_name} (${d.label}): ${d.exercises?.map(e => `${e.name} ${e.sets}×${e.reps}`).join(', ')}`).join('\n')
    : 'Not generated';

  const langNames = { en:'English', es:'Spanish', fr:'French', de:'German', it:'Italian', pt:'Portuguese', nl:'Dutch', uk:'Ukrainian', fi:'Finnish', ar:'Arabic', zh:'Chinese', ja:'Japanese' };
  const langStr = language && language !== 'en'
    ? `\nLANGUAGE: You MUST respond entirely in ${langNames[language] || language}. Every word must be in ${langNames[language] || language}.`
    : '';

  return `You are a world-class personal trainer doing a post-workout check-in with your client. Be warm but direct. Acknowledge how they felt, give specific feedback on their session, and adapt their plan if needed.${langStr}

CLIENT: ${profile?.name || 'User'}, ${profile?.age}yo ${profile?.sex}, Goal: ${profile?.goal}

TODAY'S SESSION:
${sessionSummary}

HOW THEY FELT: ${feeling}
DIFFICULTY: ${difficulty}

RECENT HISTORY:
${historyStr}

FULL PROGRAMME:
${fullPlanStr}

NUTRITION: ${nutrition ? `${nutrition.calories} kcal — ${nutrition.protein_g}g protein` : 'N/A'}

YOUR TASK:
1. Acknowledge how the session went specifically (reference the actual exercises and weights)
2. Give one sharp insight or observation about their performance
3. If difficulty was 'too_easy' — suggest adding weight or sets next session. If 'too_hard' — suggest reducing weight or volume. If 'just_right' — confirm they're on track.
4. If the pattern across multiple sessions suggests a plan change is needed, make it using the PLAN_UPDATE tag below.
5. End with one motivating but real closing line.

PLAN EDITING: If you decide to adapt the plan based on their feedback, include a <PLAN_UPDATE> tag:
<PLAN_UPDATE>{"type":"update_exercise","day_index":0,"exercise_name":"Exercise Name","changes":{"sets":"4","reps":"8-10"},"summary":"Brief description of change"}</PLAN_UPDATE>

The tag will be hidden from the user — only your text is shown. Always explain any changes you make in your text response.`;
}


// ── GET CONVERSATIONS LIST ─────────────────────────────
app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chat_conversations')
      .select('id, title, created_at, updated_at')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ conversations: data });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET SINGLE CONVERSATION ────────────────────────────
app.get('/api/conversations/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chat_conversations')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) throw error;
    res.json({ conversation: data });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── VIEW RAW PLAN DAYS (for debugging) ────────
app.get('/api/plan/days', requireAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('plans').select('workout_plan').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).maybeSingle();
    const days = data?.workout_plan?.days?.map(d => ({
      day_index: d.day_index,
      day_name: d.day_name,
      label: d.label,
      exercise_count: d.exercises?.length || 0
    })) || [];
    res.json({ days });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── REPAIR PLAN DAYS (fix corrupted day_index values) ──
app.post('/api/plan/repair-days', requireAuth, async (req, res) => {
  try {
    const { data: planData } = await supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).maybeSingle();
    if (!planData) return res.status(404).json({ error: 'No plan found' });

    const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const plan = JSON.parse(JSON.stringify(planData.workout_plan));

    // req.body.assignments: [{ label: 'Push A', day_index: 0 }, ...]
    // OR just renumber them sequentially if no assignments given
    if (req.body.assignments) {
      req.body.assignments.forEach(a => {
        const day = plan.days.find(d => d.label === a.label);
        if (day) {
          day.day_index = a.day_index;
          day.day_name = dayNames[a.day_index];
        }
      });
    } else {
      // Sequential repair: sort by current index, then reassign cleanly
      plan.days.sort((a, b) => (a.day_index || 0) - (b.day_index || 0));
    }

    plan.days.sort((a, b) => a.day_index - b.day_index);

    await supabase.from('plans').update({ workout_plan: plan, translations: {} }).eq('id', planData.id);
    res.json({ success: true, days: plan.days.map(d => ({ day_index: d.day_index, day_name: d.day_name, label: d.label })) });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});


app.post('/api/conversations', requireAuth, async (req, res) => {
  try {
    const { id, title, messages } = req.body;

    if (id) {
      // Update existing
      const { data, error } = await supabase
        .from('chat_conversations')
        .update({ messages, title, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', req.user.id)
        .select()
        .maybeSingle();

      if (error) throw error;
      res.json({ conversation: data });
    } else {
      // Create new
      const { data, error } = await supabase
        .from('chat_conversations')
        .insert({ user_id: req.user.id, title, messages })
        .select()
        .maybeSingle();

      if (error) throw error;
      res.json({ conversation: data });
    }
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE CONVERSATION ────────────────────────────────
app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('chat_conversations')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});


// ── SUBSCRIPTION — Get current status ─────────────────
app.get('/api/subscription', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { tier, accessTier, status, isExempt, trialEndsAt } = req.subscription;

    let trialDaysLeft = 0;
    if (status === 'trial' && trialEndsAt) {
      trialDaysLeft = Math.max(0, Math.ceil((new Date(trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)));
    }

    const coachUsage = await getCoachUsage(req.user.id);

    // Include stripe_subscription_id so frontend can detect paid subscribers
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_subscription_id')
      .eq('id', req.user.id)
      .maybeSingle();

    // Fetch renewal date from Stripe if active subscriber
    let renewalDate = null;
    if (status === 'active' && profile?.stripe_subscription_id) {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
        renewalDate = new Date(stripeSub.current_period_end * 1000).toISOString();
      } catch(e) { /* non-fatal */ }
    }

    res.json({
      tier,
      accessTier,
      status,
      isExempt,
      trialDaysLeft,
      trialEndsAt: trialEndsAt || null,
      coachUsage,
      coachLimit: 20,
      hasUnlimitedCoach: hasAccess('unlimited_coach', accessTier, isExempt),
      stripe_subscription_id: profile?.stripe_subscription_id || null,
      renewalDate,
    });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════
// STRIPE CHECKOUT
// ═══════════════════════════════════════════════════════

app.post('/api/stripe/create-checkout', requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured — check STRIPE_SECRET_KEY env var' });    const { tier, billing, is_promo } = req.body;
    if (!tier || !billing) return res.status(400).json({ error: 'Missing tier or billing' });

    const userId = req.user.id;
    const userEmail = req.user.email;

    // Determine price ID
    let priceKey;
    if (billing === 'lifetime') {
      priceKey = `${tier}_founding`;
    } else if (is_promo && (tier === 'steel' || tier === 'forge')) {
      priceKey = `${tier}_${billing}_promo`;
    } else {
      priceKey = `${tier}_${billing}`;
    }

    const priceId = STRIPE_PRICES[priceKey];
    if (!priceId) return res.status(400).json({ error: `No price found for ${priceKey}` });

    // Get or create Stripe customer
    const { data: profile } = await supabase.from('profiles')
      .select('stripe_customer_id, name').eq('id', userId).maybeSingle();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        name: profile?.name || '',
        metadata: { user_id: userId },
      });
      customerId = customer.id;
      await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
    }

    const isSubscription = billing !== 'lifetime';
    const frontendUrl = process.env.FRONTEND_URL || 'https://klemforge.com';
    const appUrl = frontendUrl.replace(/\/$/, '') + '/app.html';

    const sessionParams = {
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: isSubscription ? 'subscription' : 'payment',
      success_url: `${appUrl}?payment=success&tier=${tier}&billing=${billing}`,
      cancel_url: `${appUrl}?payment=cancelled`,
      metadata: { user_id: userId, tier, billing, is_promo: String(!!is_promo) },
      allow_promotion_codes: true,
    };

    if (isSubscription) {
      sessionParams.subscription_data = { metadata: { user_id: userId, tier, billing } };
    } else {
      sessionParams.payment_intent_data = { metadata: { user_id: userId, tier, billing } };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Stripe billing portal — manage/cancel subscription
app.post('/api/stripe/portal', requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured — check STRIPE_SECRET_KEY env var' });    const { data: profile } = await supabase.from('profiles')
      .select('stripe_customer_id').eq('id', req.user.id).maybeSingle();
    if (!profile?.stripe_customer_id) return res.status(400).json({ error: 'No Stripe customer found. Please make a purchase first.' });
    const frontendUrl = process.env.FRONTEND_URL || 'https://klemforge.com';
    const appUrl = frontendUrl.replace(/\/$/, '') + '/app.html';
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${appUrl}?portal_return=true`,
    });
    res.json({ url: session.url });
  } catch(err) {
    console.error('Billing portal error:', err.message);
    // Common cause: portal not configured in Stripe dashboard
    if (err.message?.includes('configuration')) {
      return res.status(500).json({ error: 'Billing portal not configured. Go to Stripe Dashboard → Settings → Billing → Customer portal and save the settings.' });
    }
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Sync subscription tier from Stripe — called after billing portal return
app.post('/api/stripe/sync-subscription', requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured — check STRIPE_SECRET_KEY env var' });    const { data: profile } = await supabase.from('profiles')
      .select('stripe_subscription_id, stripe_customer_id').eq('id', req.user.id).maybeSingle();
    if (!profile?.stripe_subscription_id) return res.json({ ok: true, synced: false });
    const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
    const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : 'expired';
    const priceId = sub.items?.data?.[0]?.price?.id;
    const tier = priceId ? getTierFromPriceId(priceId) : null;
    const updateData = { subscription_status: status };
    if (tier) updateData.subscription_tier = tier;
    await supabase.from('profiles').update(updateData).eq('id', req.user.id);
    res.json({ ok: true, synced: true, tier, status });
  } catch(err) {
    console.error('Sync subscription error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ADMIN — Get all users ──────────────────────────────
// ── ADMIN: Wipe all translation caches (forces re-translation for all users) ──
app.post('/api/admin/clear-translation-cache', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('plans')
      .update({ translations: {} })
      .neq('id', '00000000-0000-0000-0000-000000000000'); // update all rows
    if (error) throw error;
    res.json({ success: true, message: 'All translation caches cleared' });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: profiles, error: profileErr } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (profileErr) {
      console.error('Profile fetch error:', profileErr);
      throw profileErr;
    }

    // listUsers is paginated — fetch all pages
    let allAuthUsers = [];
    let page = 1;
    const perPage = 1000;
    while (true) {
      const { data, error: authErr } = await supabase.auth.admin.listUsers({ page, perPage });
      if (authErr) {
        console.error('Auth listUsers error:', authErr);
        throw authErr;
      }
      allAuthUsers = allAuthUsers.concat(data.users || []);
      if (!data.users || data.users.length < perPage) break;
      page++;
    }

    const emailMap = {};
    allAuthUsers.forEach(u => emailMap[u.id] = u.email);

    const users = (profiles || []).map(p => ({ ...p, email: emailMap[p.id] || '—' }));
    res.json({ users });
  } catch (err) {
    console.error('Admin users error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ADMIN — Freeze/unfreeze user ───────────────────────
app.patch('/api/admin/users/:userId/freeze', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { is_frozen } = req.body;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({ is_frozen: is_frozen === true })
      .eq('id', userId)
      .select()
      .maybeSingle();
    if (error) throw error;

    // If freezing, sign out all sessions for this user immediately
    if (is_frozen) {
      await supabase.auth.admin.signOut(userId, 'global').catch(() => {});
    }

    res.json({ success: true, profile: data });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ADMIN — Delete user ────────────────────────────────
app.delete('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.params;
  try {
    // Get target user's email
    const { data: { user: targetUser } } = await supabase.auth.admin.getUserById(userId);

    // Block deletion of admin account
    if (targetUser?.email === process.env.ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Cannot delete the admin account.' });
    }

    // Delete all user data from every table first
    await Promise.all([
      supabase.from('exercise_history').delete().eq('user_id', userId),
      supabase.from('session_logs').delete().eq('user_id', userId),
      supabase.from('personal_records').delete().eq('user_id', userId),
      supabase.from('bodyweight_log').delete().eq('user_id', userId),
      supabase.from('plans').delete().eq('user_id', userId),
      supabase.from('chat_conversations').delete().eq('user_id', userId),
      supabase.from('push_subscriptions').delete().eq('user_id', userId),
      supabase.from('streaks').delete().eq('user_id', userId),
      supabase.from('user_stats').delete().eq('user_id', userId),
      supabase.from('weekly_reviews').delete().eq('user_id', userId),
      supabase.from('body_metrics').delete().eq('user_id', userId),
      supabase.from('deload_flags').delete().eq('user_id', userId),
      supabase.from('onboarding_missions').delete().eq('user_id', userId),
      supabase.from('ai_coach_usage').delete().eq('user_id', userId),
      supabase.from('programmes').delete().eq('user_id', userId),
      supabase.from('monthly_reviews').delete().eq('user_id', userId),
    ]);

    // Delete profile row
    await supabase.from('profiles').delete().eq('id', userId);

    // Delete auth account
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});


// ── ADMIN — Set user tier ──────────────────────
// ── USER TIER SELECTION (preview — Stripe not yet live) ──
// NOTE: This sets a COSMETIC tier preference only (used during the free trial so the
// UI can show "you're on Steel"). It does NOT grant paid entitlement: loadSubscription's
// ENTITLEMENT GUARD ignores subscription_tier unless the status is actually paid/active,
// so a user cannot escalate to Steel/Forge for free by calling this. Real upgrades go
// through Stripe (/api/stripe/create-checkout → webhook).
app.patch('/api/subscription/tier', requireAuth, async (req, res) => {
  const { tier } = req.body;
  const validTiers = ['iron', 'steel', 'forge'];
  if (!validTiers.includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
  try {
    const { data, error } = await supabase
      .from('profiles')
      .update({ subscription_tier: tier })
      .eq('id', req.user.id)
      .select('subscription_tier, subscription_status, trial_ends_at, is_exempt')
      .maybeSingle();
    if (error) throw error;
    res.json({ success: true, tier: data.subscription_tier, trialEndsAt: data.trial_ends_at });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/admin/users/:userId/expire-trial', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('profiles')
      .update({
        subscription_status: 'expired',
        trial_ends_at: new Date().toISOString(),
      })
      .eq('id', req.params.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/admin/users/:userId/tier', requireAuth, requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { tier, is_exempt } = req.body;

  const validTiers = ['iron', 'steel', 'forge'];
  if (tier && !validTiers.includes(tier)) {
    return res.status(400).json({ error: 'Invalid tier. Must be iron, steel, or forge.' });
  }

  try {
    const updates = {};
    if (tier !== undefined) {
      updates.subscription_tier = tier;
      updates.subscription_status = 'active';
    }
    if (is_exempt !== undefined) updates.is_exempt = is_exempt;

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, profile: data });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ADMIN — Coach plan controls (trial expiry / extend / activate) ──
app.patch('/api/admin/users/:userId/coach-plan', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { action } = req.body || {};
    const updates = {};
    if (action === 'expire_trial') {
      updates.coach_plan_status = 'cancelled';
    } else if (action === 'extend_trial') {
      // Trial is a fixed 14-day window from coach_trial_start; setting start to 7 days ago
      // leaves 7 days remaining.
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      updates.coach_trial_start = sevenDaysAgo;
      updates.coach_plan_status = 'trial';
    } else if (action === 'set_active') {
      updates.coach_plan_status = 'active';
    } else {
      return res.status(400).json({ error: 'bad_action' });
    }
    const { data, error } = await supabase.from('profiles')
      .update(updates).eq('id', userId).select().maybeSingle();
    if (error) throw error;
    res.json({ success: true, profile: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── ADMIN — Coach exempt toggle (bypasses requireCoach plan-status check) ──
app.patch('/api/admin/users/:userId/coach-exempt', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { exempt } = req.body || {};
    if (typeof exempt !== 'boolean') return res.status(400).json({ error: 'bad_exempt' });
    const { data, error } = await supabase.from('profiles')
      .update({ is_coach_exempt: exempt }).eq('id', userId).select().maybeSingle();
    if (error) throw error;
    res.json({ success: true, profile: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── App version (used by frontend auto-update banner) ──
app.get('/api/version', (req, res) => {
  res.json({
    version: process.env.APP_VERSION || '1.0.0',
    deployed_at: process.env.DEPLOYED_AT || new Date().toISOString(),
  });
});


// ── PROGRAMMES — Multiple saved plans ─────────
// NOTE: table is `programmes` (pre-existing live feature + data), NOT
// `saved_programmes` from the task spec. Extended in place with a `description`
// column rather than forking a parallel table. Tier limits: Iron = 1 (upgrade
// prompt), Steel = 3, Forge/exempt = unlimited. See decisions.md.
const PROGRAMME_TIER_LIMIT = { iron: 1, steel: 3, forge: Infinity };

// Generate a one-line AI description (Haiku, max ~12 words) for a programme and store
// it on the row. Fire-and-forget: callers do NOT await this — it runs after the
// response is sent and the frontend picks the description up on the next
// /api/programmes load. Best-effort: any failure is logged and swallowed.
async function generateProgrammeDescription(programmeId, data) {
  try {
    const descPrompt = `In one sentence of maximum 12 words, describe this fitness programme. Be specific about the goal, structure and focus. No fluff.\nProgramme data: ${JSON.stringify({
      goal: data.goal,
      days_per_week: data.days_per_week,
      experience: data.experience,
      sport: data.sport || null,
      day_labels: data.day_labels || null
    })}`;
    const descMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{ role: 'user', content: descPrompt }]
    });
    const aiDesc = descMsg.content?.[0]?.text?.trim();
    if (aiDesc) await supabase.from('programmes').update({ description: aiDesc.slice(0, 300) }).eq('id', programmeId);
  } catch (e) { console.warn('generateProgrammeDescription failed:', e.message); }
}

app.get('/api/programmes', requireAuth, loadSubscription, async (req, res) => {
  try {
    // FIX 8: exclude archived programmes by default. ?include_archived=true returns all
    // (the frontend uses that to render the collapsed "Archived" section).
    const includeArchived = req.query.include_archived === 'true';
    let pq = supabase
      .from('programmes')
      .select('id, name, description, created_at, is_active, is_archived, plan_data, programme_type')
      .eq('user_id', req.user.id);
    if (!includeArchived) pq = pq.or('is_archived.is.null,is_archived.eq.false');
    const { data, error } = await pq.order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ programmes: data || [] });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Full single programme including plan_data — used by the editor to pre-populate the
// custom builder, and by the read-only "View" for AI programmes. User-scoped.
app.get('/api/programmes/:id/full', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('programmes')
      .select('id, name, description, created_at, is_active, is_archived, plan_data, programme_type')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'programme_not_found' });
    res.json({ programme: data });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/programmes', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { name, description, plan_data, programme_type } = req.body;
    if (!plan_data) return res.status(400).json({ error: 'No plan data provided' });

    const { accessTier, isExempt } = req.subscription;
    const tier = isExempt ? 'forge' : (accessTier || 'iron');
    const limit = PROGRAMME_TIER_LIMIT[tier] ?? 1;

    const { count } = await supabase
      .from('programmes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .or('is_archived.is.null,is_archived.eq.false'); // FIX 8: archived don't count toward the limit

    if ((count || 0) >= limit) {
      // Iron → upgrade prompt; Steel → at its 3-programme cap.
      if (tier === 'iron') {
        return res.status(409).json({
          error: 'upgrade_required',
          message: 'Save multiple programmes for different goals — available on Steel and Forge.'
        });
      }
      return res.status(409).json({
        error: 'programme_limit_reached',
        message: `You've reached your ${limit} programme limit on ${tier[0].toUpperCase() + tier.slice(1)}. Upgrade to Forge for unlimited programmes.`
      });
    }

    // programme_type: 'custom' for the manual builder, defaults to 'workout' for everything
    // else. Stored so the My Programmes list / Log panel can distinguish custom builds.
    const insertRow = {
      user_id: req.user.id,
      name: (name || 'My Programme').toString().slice(0, 80),
      description: description ? description.toString().slice(0, 300) : null,
      plan_data,
      is_active: false,
      programme_type: (programme_type || 'workout').toString().slice(0, 40)
    };
    let { data, error } = await supabase
      .from('programmes')
      .insert(insertRow)
      .select('id, name, description, created_at, is_active, programme_type')
      .maybeSingle();
    // Graceful fallback if the programmes.programme_type column has not been migrated yet
    // (mirrors the units/enabled_features degrade-without-column pattern).
    if (error && /programme_type/.test(error.message || '')) {
      delete insertRow.programme_type;
      ({ data, error } = await supabase
        .from('programmes')
        .insert(insertRow)
        .select('id, name, description, created_at, is_active')
        .maybeSingle());
    }
    if (error) throw error;
    res.json({ programme: data });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Activate a programme: flips this one active + all others inactive, AND writes
// its stored plan_data into the live `plans` table so the rest of the app loads it.
// Generate a brand-new programme from a full onboarding questionnaire (Feature 1).
// Builds a synthetic profile from the supplied answers (physical stats fall back to
// the user's saved profile), runs the same AI plan generation as onboarding, and
// saves the result to `programmes` with is_active:false. Tier-gated: Iron locked,
// Steel max 3, Forge unlimited.
app.post('/api/programmes/generate', requireAuth, loadSubscription, async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');
  const heartbeat = setInterval(() => { try { res.write(''); } catch(e) { clearInterval(heartbeat); } }, 20000);
  const sendResponse = (status, data) => { clearInterval(heartbeat); res.status(status).end(JSON.stringify(data)); };
  try {
    const { accessTier, isExempt } = req.subscription;
    const tier = isExempt ? 'forge' : (accessTier || 'iron');
    const limit = PROGRAMME_TIER_LIMIT[tier] != null ? PROGRAMME_TIER_LIMIT[tier] : 1;
    if (tier === 'iron') {
      return sendResponse(409, { error: 'upgrade_required', message: 'Save multiple programmes for different goals — available on Steel and Forge.' });
    }
    const { count } = await supabase.from('programmes')
      .select('id', { count: 'exact', head: true }).eq('user_id', req.user.id)
      .or('is_archived.is.null,is_archived.eq.false'); // FIX 8: archived don't count toward the limit
    if ((count || 0) >= limit) {
      return sendResponse(409, { error: 'programme_limit_reached', message: `You've reached your ${limit} programme limit on ${tier[0].toUpperCase() + tier.slice(1)}. Upgrade to Forge for unlimited programmes.` });
    }

    const b = req.body || {};
    const name = (b.name || 'My Programme').toString().slice(0, 80);
    const language = b.language || 'en';

    // Saved profile supplies the physical stats the questionnaire does not collect.
    const { data: baseProfile } = await supabase.from('profiles')
      .select(PLAN_PROFILE_FIELDS).eq('id', req.user.id).maybeSingle();

    let injuries = (b.injuries || baseProfile?.injuries || 'none');
    if (b.sport) {
      const sp = typeof b.sport === 'string' ? b.sport : (b.sport.name || '');
      if (sp) injuries = [(injuries && injuries !== 'none') ? injuries : '', 'Sport: ' + sp].filter(Boolean).join('. ') || 'none';
    }

    const profile = {
      name: baseProfile?.name || 'User',
      age: baseProfile?.age, sex: baseProfile?.sex,
      height_cm: baseProfile?.height_cm, weight_kg: baseProfile?.weight_kg,
      goal: b.goal || baseProfile?.goal || 'muscle',
      experience: b.experience || baseProfile?.experience || 'intermediate',
      days_per_week: b.days_per_week || baseProfile?.days_per_week || 4,
      preferred_days: b.preferred_days || baseProfile?.preferred_days || 'flexible',
      equipment: b.equipment || baseProfile?.equipment || 'full_gym',
      diet_style: b.diet_style || baseProfile?.diet_style || 'anything',
      diet_restrictions: b.diet_restrictions || baseProfile?.diet_restrictions || 'none',
      injuries,
      // Inherit the user's saved session-duration preference so generated programmes
      // are sized to the same schedule as their onboarding plan.
      session_duration_varies: baseProfile?.session_duration_varies,
      session_duration_mins: baseProfile?.session_duration_mins,
      session_duration_by_day: baseProfile?.session_duration_by_day,
    };

    const mwExercises = await getMuscleWikiExercises();
    const prompt = buildPlanPrompt(profile, language, mwExercises);

    let plan = null, lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const message = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 8000,
          messages: [{ role: 'user', content: prompt }]
        });
        let clean = message.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error('No JSON object found');
        plan = JSON.parse(clean.substring(start, end + 1));
        if (!plan.workout?.days?.length) throw new Error('Plan missing workout days');
        if (!plan.nutrition?.meals?.length) throw new Error('Plan missing nutrition meals');
        if (mwExercises && plan.workout?.days) {
          for (const day of plan.workout.days) {
            for (const ex of (day.exercises || [])) {
              const exact = mwExercises.find(e => e.name.toLowerCase() === ex.name.toLowerCase());
              if (exact) { ex.name = exact.name; ex.mw_id = exact.id; continue; }
              const mwName = await resolveExerciseName(ex.name, mwExercises);
              if (mwName) { const mwEx = mwExercises.find(e => e.name === mwName); ex.name = mwName; if (mwEx) ex.mw_id = mwEx.id; }
            }
          }
        }
        break;
      } catch (err) { lastError = err; if (attempt < 2) await new Promise(r => setTimeout(r, 1000)); }
    }
    if (!plan) return sendResponse(500, { error: 'generation_failed', detail: lastError?.message });

    const goalLabel = Array.isArray(profile.goal) ? profile.goal.join(', ') : String(profile.goal || '');
    const plan_data = { workout: plan.workout, nutrition: plan.nutrition, goal: goalLabel, experience: profile.experience, days_per_week: profile.days_per_week };
    const description = b.description ? b.description.toString().slice(0, 300) : `${goalLabel} · ${profile.days_per_week} days/week`;

    const { data: saved, error: saveErr } = await supabase.from('programmes').insert({
      user_id: req.user.id, name, description, plan_data, is_active: false,
    }).select('id, name, description, created_at, is_active').maybeSingle();
    if (saveErr) throw saveErr;

    sendResponse(200, { programme_id: saved.id, programme: saved, plan_data });

    // Replace the template description with a one-line AI description, async (only
    // when the caller didn't supply their own). Picked up on next /api/programmes load.
    if (!b.description && saved?.id) {
      generateProgrammeDescription(saved.id, {
        goal: goalLabel,
        days_per_week: profile.days_per_week,
        experience: profile.experience,
        sport: b.sport || null,
        day_labels: plan.workout?.days?.map(d => d.label),
      });
    }
  } catch (err) {
    console.error('programmes/generate error:', err.message);
    sendResponse(500, { error: err.message });
  }
});

app.post('/api/programmes/:id/activate', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: prog, error: progErr } = await supabase
      .from('programmes')
      .select('id, name, plan_data')
      .eq('id', id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (progErr) throw progErr;
    if (!prog) return res.status(404).json({ error: 'programme_not_found' });

    // Pull workout/nutrition out of plan_data (stored as {workout, nutrition},
    // tolerate {workout_plan, nutrition_plan} too).
    const pd = prog.plan_data || {};
    const workout_plan = pd.workout ?? pd.workout_plan ?? null;
    let nutrition_plan = pd.nutrition ?? pd.nutrition_plan ?? null;
    if (!workout_plan) return res.status(400).json({ error: 'programme_has_no_plan' });

    // Workout-only programmes (e.g. the custom builder, programme_type 'custom') carry no
    // nutrition. Preserve the user's existing nutrition_plan instead of wiping it to null
    // when activating one. AI/onboarding programmes carry their own nutrition and override.
    if (!nutrition_plan) {
      const { data: existingPlan } = await supabase
        .from('plans').select('nutrition_plan').eq('user_id', req.user.id).maybeSingle();
      if (existingPlan && existingPlan.nutrition_plan) nutrition_plan = existingPlan.nutrition_plan;
    }

    // Replace the live plan (same clean-slate pattern as plan generation).
    await supabase.from('plans').delete().eq('user_id', req.user.id);
    const { error: planErr } = await supabase
      .from('plans')
      .insert({ user_id: req.user.id, workout_plan, nutrition_plan, translations: {}, source_language: 'en' });
    if (planErr) throw planErr;

    // Flip active flags.
    await supabase.from('programmes').update({ is_active: false }).eq('user_id', req.user.id);
    await supabase.from('programmes').update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', id).eq('user_id', req.user.id);

    res.json({ ok: true });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Update name/description, and (for the workout editor) full plan_data. When the
// edited programme is the active one, its new workout/nutrition is also written
// through to the live `plans` table so the Plan/Log panels reflect the edit at once.
app.patch('/api/programmes/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, plan_data } = req.body;
    const patch = { updated_at: new Date().toISOString() };
    if (name !== undefined) patch.name = (name || '').toString().slice(0, 80);
    if (description !== undefined) patch.description = description ? description.toString().slice(0, 300) : null;
    if (plan_data !== undefined && plan_data && typeof plan_data === 'object') patch.plan_data = plan_data;

    const { data, error } = await supabase
      .from('programmes')
      .update(patch)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select('id, name, description, created_at, is_active, plan_data, programme_type')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'programme_not_found' });

    // If plan_data changed AND this programme is the active one, push it into the live
    // plans table (same shape/clean-slate as the activate endpoint). Nutrition is
    // preserved when the (custom) programme carries none.
    if (patch.plan_data && data.is_active) {
      const pd = data.plan_data || {};
      const workout_plan = pd.workout ?? pd.workout_plan ?? null;
      let nutrition_plan = pd.nutrition ?? pd.nutrition_plan ?? null;
      if (workout_plan) {
        if (!nutrition_plan) {
          const { data: existingPlan } = await supabase
            .from('plans').select('nutrition_plan').eq('user_id', req.user.id).maybeSingle();
          if (existingPlan && existingPlan.nutrition_plan) nutrition_plan = existingPlan.nutrition_plan;
        }
        await supabase.from('plans').delete().eq('user_id', req.user.id);
        await supabase.from('plans').insert({ user_id: req.user.id, workout_plan, nutrition_plan, translations: {}, source_language: 'en' });
      }
    }

    res.json({ programme: data });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// FIX 8: archive a programme (over-limit resolution after a trial/tier downgrade).
// Archived programmes are kept but excluded from the active list and the tier-limit count.
app.patch('/api/programmes/:id/archive', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('programmes')
      .update({ is_archived: true, is_active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// FIX 8: restore an archived programme back to the active (inactive) list.
app.patch('/api/programmes/:id/restore', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('programmes')
      .update({ is_archived: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/programmes/:id', requireAuth, async (req, res) => {
  try {
    const { data: prog } = await supabase
      .from('programmes')
      .select('is_active')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (!prog) return res.status(404).json({ error: 'programme_not_found' });
    if (prog.is_active) {
      return res.status(400).json({ error: 'cannot_delete_active', message: 'Switch to another programme before deleting this one.' });
    }

    const { error } = await supabase
      .from('programmes')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});


// ── EXPORT — Workout history CSV ──────────────
app.get('/api/export/history', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { accessTier, isExempt } = req.subscription;
    if (!hasAccess('export_history', accessTier, isExempt)) {
      return res.status(403).json({
        error: 'feature_locked',
        message: 'Workout history export is available on Steel and Forge plans.'
      });
    }

    // Full export — intentionally unlimited (the user is downloading their whole
    // history). Selecting only the columns the CSV emits instead of every column.
    const { data: sessions, error } = await supabase
      .from('session_logs')
      .select('logged_at, exercises, feeling, difficulty')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: false });

    if (error) throw error;

    const { data: profile } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', req.user.id)
      .maybeSingle();

    // Build CSV
    const rows = ['Date,Exercise,Set,Weight (kg),Reps,Session Rating,Session Difficulty'];
    for (const session of sessions || []) {
      const date = session.logged_at?.split('T')[0] || '';
      const rating = session.feeling || '';
      const difficulty = session.difficulty || '';
      const exercises = session.exercises || [];
      for (const ex of exercises) {
        const sets = ex.sets_data || [];
        if (sets.length === 0) {
          rows.push(`${date},"${ex.name}",—,—,—,${rating},${difficulty}`);
        } else {
          sets.forEach((s, i) => {
            rows.push(`${date},"${ex.name}",${i + 1},${s.weight || 0},${s.reps || 0},${rating},${difficulty}`);
          });
        }
      }
    }

    const csv = rows.join('\n');
    const filename = `FORGE_History_${profile?.name || 'User'}_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});


// ── MONTHLY REVIEW — Latest ────────────────────
// ── WEEKLY REVIEW GENERATE ─────────────────────
app.post('/api/review/generate', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { accessTier, isExempt } = req.subscription;
    if (!hasAccess('weekly_review', accessTier, isExempt)) {
      return res.status(403).json({ error: 'feature_locked', message: 'Weekly reviews are available on Steel and above.' });
    }

    const userId = req.user.id;

    // Coach review guard — if client has an active coach who disabled weekly reviews, skip.
    if (await isReviewDisabledByCoach(userId, 'weekly_review_enabled')) {
      return res.status(403).json({ error: 'disabled_by_coach', message: 'Your coach has paused weekly AI reviews.' });
    }

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay()); // Sunday
    weekStart.setHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const [profileRes, sessionsRes, prsRes] = await Promise.all([
      supabase.from('profiles').select('name, goal, days_per_week').eq('id', userId).maybeSingle(),
      supabase.from('workout_logs').select('*').eq('user_id', userId).gte('created_at', weekStart.toISOString()),
      supabase.from('personal_records').select('exercise_name, weight_kg, reps').eq('user_id', userId).gte('achieved_at', weekStartStr),
    ]);

    const profile = profileRes.data;
    const sessions = sessionsRes.data || [];
    const prs = prsRes.data || [];

    const sessionSummary = sessions.map(s => {
      const exStr = (s.exercises || []).map(e => {
        const setsStr = (e.sets_data || []).map(st => `${st.weight}kg×${st.reps}`).join(', ');
        return `${e.name}: ${setsStr}`;
      }).join(' | ');
      return new Date(s.created_at).toLocaleDateString('en-GB') + ': ' + (s.day_label || 'Session') + ' — ' + exStr;
    }).join('\n');

    const prompt = `You are FORGE, an AI fitness coach. Write a short weekly review for ${profile?.name || 'this athlete'}.

Week: ${weekStartStr}
Goal: ${profile?.goal || 'Build muscle'}
Sessions completed: ${sessions.length}
PRs hit: ${prs.length}${prs.length ? ' (' + prs.map(p => `${p.exercise_name}: ${p.weight_kg}kg×${p.reps}`).join(', ') + ')' : ''}

Session log:
${sessionSummary || 'No sessions logged this week.'}

Write a concise weekly review (100-150 words) covering: how the week went, any highlights, one thing to focus on next week. Be direct and specific. Use their actual numbers. No filler.`;

    const aiRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const summary = aiRes.content[0]?.text || '';

    // Save — delete existing for this week then insert
    await supabase.from('weekly_reviews').delete().eq('user_id', userId).eq('week_start', weekStartStr);

    const { error: insertErr } = await supabase.from('weekly_reviews').insert({
      user_id: userId,
      week_start: weekStartStr,
      workouts_completed: sessions.length,
      workouts_planned: profile?.days_per_week || 4,
      prs_hit: prs.length,
      summary,
      ai_insights: summary,
      created_at: new Date().toISOString(),
    });

    if (insertErr) console.error('Weekly review insert error:', insertErr);

    res.json({ review: { summary, workouts_completed: sessions.length, prs_hit: prs.length, week_start: weekStartStr } });
  } catch (err) {
    console.error('Weekly review generate error:', err);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── WEEKLY REVIEW LATEST (fallback if retention routes missing) ─────────────
app.get('/api/review/latest', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { accessTier, isExempt } = req.subscription;
    if (!hasAccess('weekly_review', accessTier, isExempt)) {
      return res.status(403).json({ error: 'feature_locked' });
    }
    const { data, error } = await supabase
      .from('weekly_reviews')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) console.error('weekly review latest error:', error);
    // Normalise field names
    if (data && !data.summary && data.ai_insights) data.summary = data.ai_insights;
    res.json({ review: data || null });
  } catch (err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── MONTHLY REVIEW LATEST ──────────────────────
app.get('/api/monthly-review/latest', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { accessTier, isExempt } = req.subscription;
    if (!hasAccess('monthly_review', accessTier, isExempt)) {
      return res.status(403).json({ error: 'feature_locked', message: 'Monthly reviews are available on the Forge plan.' });
    }

    const { data, error } = await supabase
      .from('monthly_reviews')
      .select('*')
      .eq('user_id', req.user.id)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) console.error('monthly-review/latest error:', error);

    // Normalise field names — table may use review_content instead of summary
    if (data && !data.summary && data.review_content) {
      data.summary = data.review_content;
    }

    res.json({ review: data || null });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── MONTHLY REVIEW GENERATE ────────────────────
app.post('/api/monthly-review/generate', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { accessTier, isExempt } = req.subscription;
    if (!hasAccess('monthly_review', accessTier, isExempt)) {
      return res.status(403).json({ error: 'feature_locked', message: 'Monthly reviews are available on the Forge plan.' });
    }

    const userId = req.user.id;

    // Coach review guard — if client has an active coach who disabled monthly reviews, skip.
    if (await isReviewDisabledByCoach(userId, 'monthly_review_enabled')) {
      return res.status(403).json({ error: 'disabled_by_coach', message: 'Your coach has paused monthly AI reviews.' });
    }

    // Gather monthly data
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthName = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const [profileRes, sessionsRes, prsRes, metricsRes] = await Promise.all([
      supabase.from('profiles').select('name, goal, experience, days_per_week').eq('id', userId).maybeSingle(),
      supabase.from('workout_logs').select('*').eq('user_id', userId).gte('created_at', monthStart).order('created_at', { ascending: false }),
      supabase.from('personal_records').select('exercise_name, weight_kg, reps').eq('user_id', userId).gte('achieved_at', monthStart),
      supabase.from('body_metrics').select('weight_kg, logged_at').eq('user_id', userId).gte('logged_at', monthStart).order('logged_at', { ascending: false }),
    ]);

    const profile = profileRes.data;
    const sessions = sessionsRes.data || [];
    const prs = prsRes.data || [];
    const metrics = metricsRes.data || [];

    const sessionSummary = sessions.map(s => {
      const dateStr = new Date(s.created_at).toLocaleDateString('en-GB');
      const exStr = (s.exercises || []).map(e => {
        const setsStr = (e.sets_data || []).map(st => st.weight + 'kg×' + st.reps).join(', ');
        return e.name + ' ' + setsStr;
      }).join(' | ');
      return dateStr + ': ' + (s.day_label || 'Session') + ' — ' + exStr;
    }).join('\n');

    const prompt = `You are a personal trainer writing a monthly deep-dive review for ${profile?.name || 'this athlete'}.

Month: ${monthName}
Goal: ${profile?.goal || 'Build muscle'}
Experience: ${profile?.experience || 'intermediate'}
Sessions completed: ${sessions.length}
PRs hit this month: ${prs.length}
${metrics.length ? `Latest weight: ${metrics[0].weight_kg || '—'}kg` : ''}

Session log:
${sessionSummary || 'No sessions logged this month.'}

PRs: ${prs.map(p => `${p.exercise_name}: ${p.weight_kg}kg × ${p.reps}`).join(', ') || 'None'}

Write a concise but thorough monthly review (250-350 words) covering:
1. Overall assessment of the month
2. Key strength progressions or PRs worth highlighting
3. Patterns you noticed (consistency, weak days, strong exercises)
4. One thing they did really well
5. One specific focus area for next month
6. A short motivating close

Be direct, specific, and use their actual numbers. No generic filler. Write like a coach who actually looked at their data.`;

    const aiRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const summary = aiRes.content[0]?.text || '';

    // Build month key matching cron script schema (YYYY-MM)
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Save to monthly_reviews — delete existing for this user/month then insert fresh
    const { error: deleteErr } = await supabase.from('monthly_reviews')
      .delete()
      .eq('user_id', userId)
      .eq('month', month);
    if (deleteErr) console.error('monthly review delete error:', deleteErr);

    const adherence = profile?.days_per_week
      ? Math.round((sessions.length / (parseInt(profile.days_per_week) * 4.3)) * 100)
      : null;

    const { error: insertErr } = await supabase.from('monthly_reviews').insert({
      user_id: userId,
      month,
      month_start: monthStart,
      workouts_completed: sessions.length,
      prs_hit: prs.length,
      adherence_pct: adherence,
      summary,
      review_content: summary,
      generated_at: new Date().toISOString(),
    });

    if (insertErr) {
      console.error('Monthly review save error:', insertErr);
    }

    res.json({ review: { summary, workouts_completed: sessions.length, prs_hit: prs.length, month_start: monthStart } });
  } catch(err) {
    console.error('Monthly review error:', err);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ONBOARDING MISSIONS — mark complete (robust override) ──
// The retention router ALSO defines POST /missions/:key/complete, but its handler
// returns 404 ("Mission not found") whenever the user has no seeded onboarding_missions
// row — which is the case for accounts created before the seed trigger existed (or any
// environment where the trigger was never installed). The frontend fires these on login
// and panel-open, so those users saw a stream of 404s in the console.
//
// This override is registered BEFORE the retention mount below, so Express matches it
// first and the router's update-only handler never runs for this path. It creates the
// mission row on demand (check-then-insert — NOT an onConflict upsert, which has bitten
// us before when the unique constraint was missing; see the bodyweight fix in
// known-bugs.md) and, because missions are non-critical gamification, it always resolves
// to a 200 so the client never sees a console error.
app.post('/api/missions/:missionId/complete', requireAuth, async (req, res) => {
  const key = req.params.missionId;
  try {
    const now = new Date().toISOString();
    const { data: existing } = await supabase
      .from('onboarding_missions')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('mission_key', key)
      .maybeSingle();

    let row;
    if (existing) {
      const { data, error } = await supabase
        .from('onboarding_missions')
        .update({ completed: true, completed_at: now })
        .eq('id', existing.id)
        .select()
        .maybeSingle();
      if (error) throw error;
      row = data;
    } else {
      const { data, error } = await supabase
        .from('onboarding_missions')
        .insert({ user_id: req.user.id, mission_key: key, completed: true, completed_at: now })
        .select()
        .maybeSingle();
      if (error) throw error;
      row = data;
    }

    // Keep profiles.onboarding_score in sync (best-effort — never fail on this).
    let score = null;
    try {
      const { data: all } = await supabase
        .from('onboarding_missions')
        .select('completed')
        .eq('user_id', req.user.id);
      score = (all || []).filter(m => m.completed).length;
      await supabase.from('profiles').update({ onboarding_score: score }).eq('id', req.user.id);
    } catch (e) { /* onboarding_score is non-critical */ }

    res.json({ ok: true, mission: row || { mission_key: key, completed: true }, score });
  } catch (err) {
    // Non-critical feature — log it but never surface a 404/500 to the client.
    console.warn('[missions] complete fallback for', key, '—', err.message);
    res.json({ ok: true, mission: key, completed: true });
  }
});

// ── RETENTION FEATURES ────────────────────────
try {
  const retentionRoutes = require('./routes/retention')(supabase, anthropic);
  app.use('/api', requireAuth, retentionRoutes);
  console.log('Retention routes loaded OK');
} catch (err) {
  console.error('Failed to load retention routes:', err.message);
}

// ── START ──────────────────────────────────────
// ── EXERCISE LOOKUP — YouTube video search ───────────────
app.get('/api/exercise/search', requireAuth, async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  const mwSearchUrl = 'https://musclewiki.com/search?q=' + encodeURIComponent(name);

  // Resolve AI name via manual map
  const nameLower = name.toLowerCase().trim();
  const stripped = nameLower.replace(/^(barbell|dumbbell|cable|machine|kettlebell|ez bar|ez-bar|bodyweight|bw|db|bb|kb)\s+/i, '');
  const resolvedName = MANUAL_EXERCISE_MAP[nameLower]
    || MANUAL_EXERCISE_MAP[stripped]
    || name;

  // Get YouTube video
  const yt = await getYouTubeVideoId(resolvedName);

  return res.json({
    exercise: {
      name: resolvedName,
      youtubeVideoId: yt?.videoId || null,
      youtubeTitle: yt?.title || null,
      videoFilename: null,  // MuscleWiki removed
      videoFilename2: null,
      instructions: [],
      primaryMuscles: [],
      category: '',
      difficulty: '',
      muscleWikiUrl: mwSearchUrl,
    }
  });
});


// ── EXERCISE VIDEO PROXY ────────────────────────────────
app.get('/api/exercise/video/*', requireAuth, (req, res) => {
  const apiKey = process.env.MUSCLEWIKI_API_KEY;
  if (!apiKey) return res.status(404).json({ error: 'No API key configured' });

  const filename = req.params[0];
  if (!filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const chunks = [];

  const proxyReq = https.request({
    hostname: 'api.musclewiki.com',
    path: '/stream/videos/branded/' + filename,
    method: 'GET',
    headers: { 'X-API-Key': apiKey }
  }, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      console.error('MuscleWiki upstream:', proxyRes.statusCode, filename);
      res.socket && res.socket.writable && res.status(proxyRes.statusCode).json({ error: 'upstream ' + proxyRes.statusCode });
      proxyRes.resume();
      return;
    }

    proxyRes.on('data', chunk => chunks.push(chunk));

    proxyRes.on('end', () => {
      if (res.headersSent || !res.socket || !res.socket.writable) return;
      const buf = Buffer.concat(chunks);
      // Write raw HTTP response to bypass Express middleware charset injection
      res.socket.write(
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: video/mp4\r\n' +
        'Content-Length: ' + buf.length + '\r\n' +
        'Cache-Control: public, max-age=3600\r\n' +
        'Access-Control-Allow-Origin: *\r\n' +
        'Cross-Origin-Resource-Policy: cross-origin\r\n' +
        'Connection: close\r\n' +
        '\r\n'
      );
      res.socket.write(buf);
      res.socket.end();
    });

    proxyRes.on('error', (e) => {
      console.error('proxyRes error:', e.message);
      if (!res.headersSent) { console.error('Server error:', e); res.status(500).json({ error: 'Internal server error' }); }
    });
  });

  proxyReq.on('error', (e) => {
    console.error('proxyReq error:', e.message);
    if (!res.headersSent) { console.error('Server error:', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'timeout' });
  });

  proxyReq.end();
});


// ── EXERCISE DEBUG — see raw MuscleWiki response ───────
app.get('/api/exercise/debug', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.query;
  const apiKey = process.env.MUSCLEWIKI_API_KEY;
  if (!apiKey) return res.json({ error: 'No MUSCLEWIKI_API_KEY set' });

  try {
    const searchRes = await fetch(
      'https://api.musclewiki.com/search?q=' + encodeURIComponent(name || 'bench press') + '&limit=3',
      { headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' } }
    );
    const searchRaw = await searchRes.text();
    let searchData;
    try { searchData = JSON.parse(searchRaw); } catch(e) { searchData = searchRaw; }

    // If we got results, fetch detail for first one
    const results = searchData?.results || searchData?.exercises || (Array.isArray(searchData) ? searchData : []);
    let detailData = null;
    if (results.length > 0 && results[0].id !== undefined) {
      const detailRes = await fetch(
        'https://api.musclewiki.com/exercises/' + results[0].id,
        { headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' } }
      );
      const detailRaw = await detailRes.text();
      try { detailData = JSON.parse(detailRaw); } catch(e) { detailData = detailRaw; }
    }

    // Also simulate what the main route would build
    let builtGifUrl = null;
    if (detailData) {
      const videos = detailData.videos || detailData.video_list || [];
      if (videos.length > 0) {
        const v = videos[0];
        const filename = v.filename || v.file || v;
        if (typeof filename === 'string') {
          builtGifUrl = 'https://api.musclewiki.com/stream/videos/branded/' + filename;
        } else if (v.url) {
          builtGifUrl = v.url;
        }
      }
    }

    res.json({
      status: searchRes.status,
      searchResponse: searchData,
      firstResultKeys: detailData ? Object.keys(detailData) : null,
      firstResultDetail: detailData,
      builtGifUrl,
      apiKeyPresent: !!apiKey,
    });
  } catch(err) {
    console.error('Server error:', err); res.json({ error: 'Internal server error' });
  }
});


// ── EXERCISE VIDEO TRACE — full debug trace for video lookup ──
// ── YOUTUBE VIDEO TEST ────────────────────────────────
app.get('/api/exercise/yt-test', requireAuth, requireAdmin, async (req, res) => {
  const name = req.query.name || 'Barbell Bench Press';
  const force = req.query.force === '1'; // ?force=1 bypasses cache
  if (force) {
    const lower = name.toLowerCase().trim();
    _ytCache.delete(lower);
    // Also clear from Supabase
    supabase.from('exercise_video_cache').delete().eq('exercise_name', lower).then(() => {}).catch(() => {});
  }
  const yt = await getYouTubeVideoId(name);
  res.json({ name, result: yt, youtubeKeyPresent: !!process.env.YOUTUBE_API_KEY });
});

// ── MUSCLEWIKI RAW DIAGNOSTIC ─────────────────────────
app.get('/api/exercise/mw-debug', requireAuth, requireAdmin, async (req, res) => {
  const apiKey = process.env.MUSCLEWIKI_API_KEY;
  if (!apiKey) return res.json({ error: 'No API key' });
  try {
    // Try different endpoints to find what works
    const results = {};

    // Test 1: exercises list — check pagination fields
    const r1 = await fetch('https://api.musclewiki.com/exercises?limit=5&offset=0', {
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
    });
    const d1 = await r1.json();
    results.list_status = r1.status;
    results.list_all_keys = Object.keys(d1);
    results.list_count = d1.count;
    results.list_total = d1.total;
    results.list_next = d1.next;
    results.list_results_length = d1.results?.length;
    results.list_is_array = Array.isArray(d1);
    results.list_sample = d1.results?.[0] ? { id: d1.results[0].id, name: d1.results[0].name } : null;

    // Test 1b: try page 2 to see if offset works
    const r1b = await fetch('https://api.musclewiki.com/exercises?limit=5&offset=5', {
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
    });
    const d1b = await r1b.json();
    results.page2_first_name = d1b.results?.[0]?.name || 'same or empty';
    results.page2_status = r1b.status;

    // Test 1c: try limit=200 to see if it goes above 100
    const r1c = await fetch('https://api.musclewiki.com/exercises?limit=200&offset=0', {
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
    });
    const d1c = await r1c.json();
    results.limit200_count = d1c.results?.length || 0;

    // Test 1d: try different pagination param names
    const r1d = await fetch('https://api.musclewiki.com/exercises?page_size=200', {
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
    });
    const d1d = await r1d.json();
    results.page_size_param_count = d1d.results?.length || 0;

    // Test 2: single exercise detail
    const firstId = d1.results?.[0]?.id || d1.results?.[0]?.pk || (Array.isArray(d1) && d1[0]?.id);
    if (firstId) {
      const r2 = await fetch('https://api.musclewiki.com/exercises/' + firstId, {
        headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
      });
      const d2 = await r2.json();
      results.detail_status = r2.status;
      results.detail_keys = Object.keys(d2);
      results.detail_has_videos = !!(d2.videos?.length);
      results.detail_video_sample = d2.videos?.[0];
    }

    // Test 3: current cache state
    results.cache_size = mwExerciseCache ? mwExerciseCache.length : 0;
    results.cache_age_minutes = mwExerciseCacheTime ? Math.round((Date.now() - mwExerciseCacheTime) / 60000) : null;

    res.json(results);
  } catch(e) {
    console.error('Server error:', e); res.json({ error: 'Internal server error' });
  }
});

app.get('/api/exercise/test-video', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name param required' });
  const trace = [];
  const apiKey = process.env.MUSCLEWIKI_API_KEY;
  trace.push({ step: 'input', name, apiKeyPresent: !!apiKey });

  try {
    // Step 1: Load exercise cache
    const exercises = await getMuscleWikiExercises();
    trace.push({ step: 'cache', exerciseCount: exercises?.length || 0 });

    if (!exercises) return res.json({ trace, error: 'No exercise cache available' });

    // Log sample exercise structure
    if (exercises[0]) {
      trace.push({ step: 'sample_exercise_keys', keys: Object.keys(exercises[0]), id: exercises[0].id, pk: exercises[0].pk, name: exercises[0].name });
    }

    // Step 2: Resolve name
    const resolvedName = await resolveExerciseName(name, exercises);
    trace.push({ step: 'resolve_name', input: name, resolved: resolvedName });

    // Step 3: Find match in cache
    const nameLower = name.toLowerCase().trim();
    let match = null;
    if (resolvedName) {
      match = exercises.find(e => e.name.toLowerCase() === resolvedName.toLowerCase());
    }
    if (!match) {
      // Try fuzzy
      const words = nameLower.split(' ').filter(w => w.length >= 3);
      const fuzzy = exercises.filter(e => words.length >= 2 && words.every(w => e.name.toLowerCase().includes(w)));
      if (fuzzy.length) match = fuzzy.sort((a, b) => a.name.length - b.name.length)[0];
    }
    trace.push({ step: 'cache_match', found: !!match, matchName: match?.name || null, matchId: match?.id || null, matchPk: match?.pk || null, hasVideosInList: !!(match?.videos?.length) });

    if (!match) return res.json({ trace, error: 'No match found in cache' });

    // Step 4: Fetch detail by ID
    const exerciseId = match.id || match.pk;
    trace.push({ step: 'detail_fetch_start', url: 'https://api.musclewiki.com/exercises/' + exerciseId });

    if (!exerciseId) {
      trace.push({ step: 'detail_fetch_skip', reason: 'No ID on exercise object' });
      return res.json({ trace, error: 'Exercise has no id or pk field' });
    }

    const detailRes = await fetch('https://api.musclewiki.com/exercises/' + exerciseId, {
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
    });
    trace.push({ step: 'detail_response', status: detailRes.status });

    if (!detailRes.ok) {
      const errText = await detailRes.text().catch(() => '');
      trace.push({ step: 'detail_error', body: errText.substring(0, 500) });
      return res.json({ trace, error: 'Detail fetch failed: ' + detailRes.status });
    }

    const detail = await detailRes.json();
    trace.push({ step: 'detail_parsed', keys: Object.keys(detail), videoCount: detail.videos?.length || 0, detailName: detail.name });

    // Step 5: Extract video filenames
    const videos = detail.videos || [];
    if (videos.length > 0) {
      trace.push({ step: 'videos_raw', videos: videos.slice(0, 6) });
    }

    const maleFront = videos.find(v => v.gender === 'male' && v.angle === 'front');
    const maleSide = videos.find(v => v.gender === 'male' && v.angle === 'side');
    const getFilename = v => {
      if (!v?.url) return null;
      if (v.url.includes('/branded/')) return v.url.split('/branded/')[1];
      return v.url.split('/').pop() || null;
    };
    const frontFile = getFilename(maleFront) || getFilename(videos[0]) || null;
    const sideFile = getFilename(maleSide) || null;
    trace.push({ step: 'extracted_filenames', videoFilename: frontFile, videoFilename2: sideFile });

    return res.json({
      trace,
      result: { name: detail.name || match.name, videoFilename: frontFile, videoFilename2: sideFile }
    });
  } catch(err) {
    console.error('buftest error:', err);
    trace.push({ step: 'error' });
    return res.json({ trace, error: 'Internal server error' });
  }
});


// ── EXERCISE VIDEO TEST — check API key + cache status ──
app.get('/api/exercise/video-test', requireAuth, requireAdmin, async (req, res) => {
  const apiKey = process.env.MUSCLEWIKI_API_KEY;
  if (!apiKey) return res.json({ error: 'No API key set', status: 0 });

  try {
    // Check cache status
    const cached = mwExerciseCache;
    const cacheAge = cached ? Math.round((Date.now() - mwExerciseCacheTime) / 60000) : null;

    // HEAD request to MuscleWiki to verify key is valid
    const testReq = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.musclewiki.com',
        path: '/stream/videos/branded/male-barbell-bench-press-front.mp4',
        method: 'HEAD',
        headers: { 'X-API-Key': apiKey }
      }, (res2) => {
        resolve({ statusCode: res2.statusCode, headers: res2.headers });
        res2.resume();
      });
      r.on('error', reject);
      r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
      r.end();
    });

    res.json({
      status: testReq.statusCode,
      apiKeyLength: apiKey.length,
      cacheLoaded: !!cached,
      cacheSize: cached ? cached.length : 0,
      cacheAgeMinutes: cacheAge,
      message: testReq.statusCode === 200 ? 'API key valid, cache ready' : 'API key issue: status ' + testReq.statusCode,
    });
  } catch(e) {
    console.error('Server error:', e); res.json({ error: 'Internal server error', status: 0 });
  }
});

// ── VIDEO BUFFER — works (confirmed 752902 bytes) ────────
app.get('/api/exercise/buftest', requireAuth, requireAdmin, async (req, res) => {
  const apiKey = process.env.MUSCLEWIKI_API_KEY;
  // If filename param provided, serve that file as video
  const filename = req.query.f;
  const path = filename
    ? '/stream/videos/branded/' + filename
    : '/stream/videos/branded/male-barbell-bench-press-front.mp4';

  try {
    const buf = await new Promise((resolve, reject) => {
      const chunks = [];
      const r = https.request({
        hostname: 'api.musclewiki.com',
        path,
        method: 'GET',
        headers: { 'X-API-Key': apiKey }
      }, (res2) => {
        res2.on('data', c => chunks.push(c));
        res2.on('end', () => resolve(Buffer.concat(chunks)));
        res2.on('error', reject);
      });
      r.on('error', reject);
      r.end();
    });

    if (filename) {
      // Serve as actual video
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.removeHeader('X-Powered-By');
      // Send as buffer directly
      res.end(buf);
    } else {
      res.json({ success: true, bytes: buf.length });
    }
  } catch(e) {
    console.error('Server error:', e); res.json({ success: false, error: 'Internal server error' });
  }
});


// ── EXERCISE NAME REMAP — fix existing plans to use MuscleWiki names ──
app.post('/api/exercise/remap-plan', requireAuth, async (req, res) => {
  try {
    const exercises = await getMuscleWikiExercises();
    if (!exercises) return res.json({ success: false, error: 'Cache not ready' });

    const { data: planRow } = await supabase
      .from('plans').select('plan_data').eq('user_id', req.user.id).maybeSingle();

    if (!planRow?.plan_data) return res.json({ success: false, error: 'No plan found' });

    let changed = 0;
    const plan = planRow.plan_data;
    for (const day of (plan.workout_plan?.days || [])) {
      for (const ex of (day.exercises || [])) {
        const mwName = await resolveExerciseName(ex.name, exercises);
        if (mwName && mwName !== ex.name) {
          ex.name = mwName;
          changed++;
        }
      }
    }

    if (changed > 0) {
      await supabase.from('plans').update({ plan_data: plan }).eq('user_id', req.user.id);
    }

    res.json({ success: true, remapped: changed });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════
// LAUNCH PRICING SYSTEM
// ═══════════════════════════════════════════════════════

const LAUNCH_PROMO_THRESHOLD = 500;

// Get current launch pricing status
async function getLaunchPricingStatus() {
  try {
    const { data } = await supabase
      .from('launch_pricing_config')
      .select('*')
      .maybeSingle();
    if (!data) {
      // Default state — both active, 0 sold
      return {
        steel_active: true, steel_sold: 0, steel_threshold: LAUNCH_PROMO_THRESHOLD,
        forge_active: true, forge_sold: 0, forge_threshold: LAUNCH_PROMO_THRESHOLD,
      };
    }
    return {
      steel_active: data.steel_active && data.steel_sold < LAUNCH_PROMO_THRESHOLD,
      steel_sold: data.steel_sold || 0,
      steel_threshold: LAUNCH_PROMO_THRESHOLD,
      forge_active: data.forge_active && data.forge_sold < LAUNCH_PROMO_THRESHOLD,
      forge_sold: data.forge_sold || 0,
      forge_threshold: LAUNCH_PROMO_THRESHOLD,
    };
  } catch(e) {
    console.error('getLaunchPricingStatus error:', e.message);
    return { steel_active: false, steel_sold: 0, forge_active: false, forge_sold: 0 };
  }
}

// Public endpoint — frontend polls this to show/hide promo UI
app.get('/api/launch-pricing', async (req, res) => {
  const status = await getLaunchPricingStatus();
  res.json(status);
});

// Increment counter when a paid subscription completes
app.post('/api/launch-pricing/record-subscription', requireAuth, async (req, res) => {
  try {
    const { tier } = req.body; // 'steel' or 'forge'
    if (!['steel','forge'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
    const status = await getLaunchPricingStatus();
    if (!status[`${tier}_active`]) return res.json({ ok: true, promo_active: false });
    const { data: config } = await supabase.from('launch_pricing_config').select('*').maybeSingle();
    const newSold = (config?.[`${tier}_sold`] || 0) + 1;
    const nowEnded = newSold >= LAUNCH_PROMO_THRESHOLD;
    await supabase.from('launch_pricing_config').upsert({
      id: 1,
      steel_active: config?.steel_active ?? true,
      steel_sold: tier === 'steel' ? newSold : (config?.steel_sold || 0),
      forge_active: config?.forge_active ?? true,
      forge_sold: tier === 'forge' ? newSold : (config?.forge_sold || 0),
      ...(tier === 'steel' && nowEnded ? { steel_active: false } : {}),
      ...(tier === 'forge' && nowEnded ? { forge_active: false } : {}),
    });
    res.json({ ok: true, promo_active: !nowEnded, remaining: LAUNCH_PROMO_THRESHOLD - newSold });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// Admin: view and control launch pricing
app.get('/api/admin/launch-pricing', requireAuth, requireAdmin, async (req, res) => {
  const status = await getLaunchPricingStatus();
  res.json(status);
});

app.patch('/api/admin/launch-pricing', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { steel_active, forge_active } = req.body;
    const { data: config } = await supabase.from('launch_pricing_config').select('*').maybeSingle();
    await supabase.from('launch_pricing_config').upsert({
      id: 1,
      steel_active: steel_active !== undefined ? steel_active : (config?.steel_active ?? true),
      steel_sold: config?.steel_sold || 0,
      forge_active: forge_active !== undefined ? forge_active : (config?.forge_active ?? true),
      forge_sold: config?.forge_sold || 0,
    });
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

const server = app.listen(PORT, () => console.log(`FORGE backend running on port ${PORT}`));
// Increase timeout to 3 minutes — plan generation with Sonnet can take up to 90 seconds
server.timeout = 180000;
server.keepAliveTimeout = 180000;
server.headersTimeout = 185000;

// ── DEBUG — View raw plan (admin only) ────────
app.get('/api/debug/plan', requireAuth, requireAdmin, async (req, res) => {
  const { data } = await supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).maybeSingle();
  res.json(data);
});

// ── EXERCISE ID FINDER — dev tool ─────────────────────
app.get('/api/exercise/find-ids', requireAuth, requireAdmin, async (req, res) => {
  const exercises = await getMuscleWikiExercises();
  if (!exercises) return res.json({ error: 'Cache not loaded' });
  const names = (req.query.names || '').split(',').map(n => n.trim().toLowerCase());
  const results = names.map(n => {
    const matches = exercises.filter(e => e.name.toLowerCase().includes(n)).slice(0, 3);
    return { query: n, matches: matches.map(e => ({ id: e.id, name: e.name, videos: (e.videos||[]).length })) };
  });
  res.json({ results, totalCached: exercises.length });
});

// ═══════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════

// Send push notification to a user
async function sendPushToUser(userId, title, body, url = '/') {
  try {
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', userId);
    if (!subs?.length) return;
    const payload = JSON.stringify({ title, body, url });
    for (const row of subs) {
      try {
        await fetch(row.subscription.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'TTL': '86400',
          },
          body: payload,
        }).catch(() => {});
      } catch(e) { /* ignore individual failures */ }
    }
  } catch(e) { console.error('sendPushToUser error:', e.message); }
}

// Subscribe to push
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    await supabase.from('push_subscriptions').upsert({
      user_id: req.user.id,
      subscription,
    }, { onConflict: 'user_id' });
    res.json({ ok: true });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Trigger grace period notification sequence
app.post('/api/push/grace-period', requireAuth, async (req, res) => {
  const userId = req.user.id;
  // Store grace period start in profile metadata
  await supabase.from('profiles').update({ grace_period_started_at: new Date().toISOString() }).eq('id', userId);
  // Schedule notifications (fire and forget — use setTimeout for simplicity)
  // Notification 1 — 6 hours
  setTimeout(async () => {
    const { data: profile } = await supabase.from('profiles').select('subscription_status').eq('id', userId).maybeSingle();
    if (profile?.subscription_status === 'active') return; // converted — stop
    await sendPushToUser(userId,
      'FORGE',
      'Your plan is still here. Your progress is saved. Whenever you\'re ready, pick up where you left off.'
    );
  }, 6 * 60 * 60 * 1000);
  // Notification 2 — 24 hours
  setTimeout(async () => {
    const { data: profile } = await supabase.from('profiles').select('subscription_status').eq('id', userId).maybeSingle();
    if (profile?.subscription_status === 'active') return;
    await sendPushToUser(userId,
      'Your coach has something to say',
      'Your AI coach has insight on your last session. Upgrade to Steel to hear it.'
    );
  }, 24 * 60 * 60 * 1000);
  // Notification 3 — 48 hours
  setTimeout(async () => {
    const { data: profile } = await supabase.from('profiles').select('subscription_status').eq('id', userId).maybeSingle();
    if (profile?.subscription_status === 'active') return;
    // Check founding member slots
    const { data: slots } = await supabase.from('founding_member_config').select('*').maybeSingle();
    const ironAvailable = (slots?.iron_sold || 0) < (slots?.iron_total || 500);
    const steelAvailable = (slots?.steel_sold || 0) < (slots?.steel_total || 250);
    // Check Steel launch promo
    const promoStatus = await getLaunchPricingStatus();
    // Priority: A (founding) → C (steel promo) → B (fallback)
    if (ironAvailable || steelAvailable) {
      await sendPushToUser(userId, 'Founding Member slots are going', 'Lifetime access to FORGE — pay once, train forever. Limited slots remaining.');
    } else if (promoStatus.steel_active) {
      await sendPushToUser(userId, 'Launch pricing is still live', 'Steel is CHF 11.99/mo while spots remain. That price locks in permanently — it never increases.');
    } else {
      await sendPushToUser(userId, 'Your coaching is on hold', 'It takes 30 seconds to restart it.');
    }
  }, 48 * 60 * 60 * 1000);
  res.json({ ok: true });
});

// Day 3-4 founding member push (called by a scheduled job or on plan fetch)
app.post('/api/push/founding-member-notify', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    // Check if already sent
    const { data: profile } = await supabase.from('profiles')
      .select('founding_notified_at, subscription_status')
      .eq('id', userId).maybeSingle();
    if (profile?.founding_notified_at) return res.json({ ok: true, skipped: true });
    if (profile?.subscription_status === 'active') return res.json({ ok: true, skipped: true });
    // Check slots
    const { data: slots } = await supabase.from('founding_member_config').select('*').maybeSingle();
    const available = ((slots?.iron_sold || 0) < (slots?.iron_total || 500)) || ((slots?.steel_sold || 0) < (slots?.steel_total || 250));
    if (!available) return res.json({ ok: true, skipped: true });
    await sendPushToUser(userId, 'Founding Member access — limited slots', 'Pay once, train forever. First 500 members only. You\'re eligible now.');
    await supabase.from('profiles').update({ founding_notified_at: new Date().toISOString() }).eq('id', userId);
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// TESTIMONIAL — dynamic, updatable without code deploy
// ═══════════════════════════════════════════════════════
app.get('/api/testimonial', async (req, res) => {
  try {
    const { data } = await supabase.from('app_config').select('value').eq('key', 'paywall_testimonial').maybeSingle();
    res.json(data?.value || {
      quote: "Built me a full programme in under 2 minutes. I've tried four other apps. This is the first one that felt like it actually knew what I needed.",
      attribution: "— James, training for football season"
    });
  } catch(e) { console.error('Server error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/admin/testimonial', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { quote, attribution } = req.body;
    await supabase.from('app_config').upsert({ key: 'paywall_testimonial', value: { quote, attribution } }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch(e) { console.error('Server error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// TRIAL DAY 7 — IN-APP TESTIMONIAL PROMPT FEEDBACK
// ═══════════════════════════════════════════════════════
app.post('/api/trial-feedback', requireAuth, async (req, res) => {
  try {
    const { feedback } = req.body;
    await supabase.from('trial_feedback').insert({ user_id: req.user.id, feedback, created_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// FOUNDING MEMBER
// ═══════════════════════════════════════════════════════
app.get('/api/founding-member/slots', async (req, res) => {
  try {
    const { data } = await supabase.from('founding_member_config').select('*').maybeSingle();
    res.json({
      iron_total: data?.iron_total || 500,
      iron_sold: data?.iron_sold || 0,
      steel_total: data?.steel_total || 250,
      steel_sold: data?.steel_sold || 0,
    });
  } catch(e) { console.error('Server error:', e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/founding-member/claim', requireAuth, async (req, res) => {
  try {
    const { tier } = req.body; // 'iron' or 'steel'
    if (!['iron','steel'].includes(tier)) return res.status(400).json({ error: 'Invalid tier' });
    const { data: config } = await supabase.from('founding_member_config').select('*').maybeSingle();
    const sold = config?.[`${tier}_sold`] || 0;
    const total = config?.[`${tier}_total`] || (tier === 'iron' ? 500 : 250);
    if (sold >= total) return res.status(400).json({ error: 'Sold out' });
    // Increment sold counter
    await supabase.from('founding_member_config').upsert({
      id: config?.id || 1,
      [`${tier}_sold`]: sold + 1,
      iron_total: config?.iron_total || 500,
      steel_total: config?.steel_total || 250,
    });
    // Set user to lifetime
    await supabase.from('profiles').update({
      subscription_tier: tier,
      subscription_status: 'lifetime',
      lifetime_tier: tier,
    }).eq('id', req.user.id);
    res.json({ ok: true, tier });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// REFERRAL PROGRAMME
// ═══════════════════════════════════════════════════════
app.get('/api/referral', requireAuth, async (req, res) => {
  try {
    // Get or create referral code
    let { data: profile } = await supabase.from('profiles').select('referral_code, referral_stats').eq('id', req.user.id).maybeSingle();
    if (!profile?.referral_code) {
      const code = 'FORGE-' + req.user.id.replace(/-/g,'').substring(0,8).toUpperCase();
      await supabase.from('profiles').update({ referral_code: code }).eq('id', req.user.id);
      profile = { referral_code: code, referral_stats: null };
    }
    const stats = profile.referral_stats || { clicks: 0, signups: 0, conversions: 0, credits: 0 };
    res.json({ code: profile.referral_code, stats });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// Apply referral code on signup — called after account creation
app.post('/api/referral/apply', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    const { data: referrer } = await supabase.from('profiles').select('id, referral_stats').eq('referral_code', code.toUpperCase()).maybeSingle();
    if (!referrer) return res.status(404).json({ error: 'Invalid code' });
    if (referrer.id === req.user.id) return res.status(400).json({ error: 'Cannot refer yourself' });
    // Extend this user's trial to 14 days
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('profiles').update({ trial_ends_at: trialEndsAt, referred_by: referrer.id }).eq('id', req.user.id);
    // Track signup in referrer stats
    const stats = referrer.referral_stats || { clicks: 0, signups: 0, conversions: 0, credits: 0 };
    stats.signups = (stats.signups || 0) + 1;
    await supabase.from('profiles').update({ referral_stats: stats }).eq('id', referrer.id);
    res.json({ ok: true, trialDays: 14 });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// CREATOR CODES (Section 10)
// ═══════════════════════════════════════════════════════
app.post('/api/creator-code/validate', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    const { data } = await supabase.from('creator_codes')
      .select('*').eq('code', code.toUpperCase().trim()).maybeSingle();
    if (!data) return res.status(404).json({ error: 'Invalid code' });
    if (data.expires_at && new Date(data.expires_at) < new Date()) return res.status(400).json({ error: 'Code expired' });
    if (data.max_uses && data.uses_count >= data.max_uses) return res.status(400).json({ error: 'Code fully redeemed' });
    res.json({ ok: true, trial_days: data.trial_days || 14, name: data.name });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/creator-code/redeem', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const { data } = await supabase.from('creator_codes')
      .select('*').eq('code', code.toUpperCase().trim()).maybeSingle();
    if (!data) return res.status(404).json({ error: 'Invalid code' });
    // Extend trial
    const trialEndsAt = new Date(Date.now() + (data.trial_days || 14) * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('profiles').update({ trial_ends_at: trialEndsAt }).eq('id', req.user.id);
    // Track usage
    await supabase.from('creator_codes').update({
      uses_count: (data.uses_count || 0) + 1,
    }).eq('id', data.id);
    await supabase.from('creator_code_uses').insert({
      code_id: data.id, user_id: req.user.id, used_at: new Date().toISOString()
    });
    res.json({ ok: true, trial_days: data.trial_days || 14 });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// Admin: create creator code
app.post('/api/admin/creator-codes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, code, trial_days, expires_at, max_uses } = req.body;
    const { data, error } = await supabase.from('creator_codes').insert({
      name, code: code.toUpperCase(), trial_days: trial_days || 14,
      expires_at: expires_at || null, max_uses: max_uses || null, uses_count: 0
    }).select().maybeSingle();
    if (error) throw error;
    res.json({ ok: true, code: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/creator-codes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data } = await supabase.from('creator_codes').select('*').order('created_at', { ascending: false });
    res.json({ codes: data || [] });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ═══════════════════════════════════════════════════════
// COACH FEATURE
// ═══════════════════════════════════════════════════════

// ── Coach helpers ──────────────────────────────────────

// Is this user's relevant review type disabled by their active coach?
// settingField is the column name in coach_ai_review_settings, e.g. 'weekly_review_enabled'.
async function isReviewDisabledByCoach(userId, settingField) {
  try {
    const { data: link } = await supabase
      .from('coach_clients')
      .select('coach_id')
      .eq('client_id', userId)
      .eq('status', 'active')
      .maybeSingle();
    if (!link?.coach_id) return false;
    const { data: settings } = await supabase
      .from('coach_ai_review_settings')
      .select(settingField)
      .eq('coach_id', link.coach_id)
      .eq('client_id', userId)
      .maybeSingle();
    if (!settings) return false; // no row = defaults to enabled
    return settings[settingField] === false;
  } catch(e) {
    console.error('isReviewDisabledByCoach error:', e.message);
    return false;
  }
}

// Middleware — user must be an active or trialling coach
async function requireCoach(req, res, next) {
  try {
    const { data: profile } = await supabase.from('profiles')
      .select('account_type, coach_plan, coach_plan_status, coach_trial_start, name, coach_title, coach_commission_rate, is_coach_exempt')
      .eq('id', req.user.id).maybeSingle();
    if (profile?.account_type !== 'coach') {
      return res.status(403).json({ error: 'not_coach', message: 'Coach account required.' });
    }
    // Exempt accounts bypass ALL coach plan-status / trial-expiry checks
    if (profile.is_coach_exempt) {
      req.coachProfile = profile;
      return next();
    }
    if (!['active','trial'].includes(profile?.coach_plan_status)) {
      // If they were already marked expired/cancelled, surface that to the client
      if (profile?.coach_plan_status === 'expired') {
        return res.status(403).json({ error: 'coach_trial_expired', message: 'Your coach trial has ended.' });
      }
      return res.status(403).json({ error: 'not_coach', message: 'Coach account required.' });
    }
    // Active trial — check the 14-day window
    if (profile.coach_plan_status === 'trial' && profile.coach_trial_start) {
      const trialEnd = new Date(profile.coach_trial_start);
      trialEnd.setDate(trialEnd.getDate() + 14);
      if (new Date() > trialEnd) {
        await supabase.from('profiles')
          .update({ coach_plan_status: 'expired' })
          .eq('id', req.user.id);
        return res.status(403).json({ error: 'coach_trial_expired', message: 'Your coach trial has ended.' });
      }
    }
    req.coachProfile = profile;
    next();
  } catch(e) {
    console.error('Server error:', e); res.status(500).json({ error: 'Internal server error' });
  }
}

// Verify coach has an active connection with this client. Returns true/false.
async function verifyClientConnection(coachId, clientId) {
  const { data } = await supabase.from('coach_clients')
    .select('id').eq('coach_id', coachId).eq('client_id', clientId).eq('status', 'active').maybeSingle();
  return !!data;
}

// Count active clients for a coach
async function countActiveClients(coachId) {
  const { count } = await supabase
    .from('coach_clients')
    .select('id', { count: 'exact', head: true })
    .eq('coach_id', coachId)
    .in('status', ['active','pending']);
  return count || 0;
}

// Generates a private, coach-facing overview of a client and stores it on the
// coach_clients connection row. Declared as a function declaration so it is
// hoisted and callable from the connection-accept handler defined earlier.
async function generateClientSummary(coachId, clientId) {
  // Full profile (only columns that exist on profiles — there is no `sport` column)
  const { data: prof } = await supabase
    .from('profiles')
    .select('name, age, goal, experience, days_per_week, preferred_days, weight_kg, height_cm, injuries, equipment, diet_style, diet_restrictions, subscription_tier')
    .eq('id', clientId)
    .maybeSingle();
  if (!prof) throw new Error('client_profile_not_found');

  // Latest body metrics (weight, body fat if tracked)
  const { data: metrics } = await supabase
    .from('body_metrics')
    .select('weight_kg, body_fat, logged_at')
    .eq('user_id', clientId)
    .order('logged_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Session count, last 30 days
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count: sessionCount } = await supabase
    .from('session_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', clientId)
    .gte('logged_at', monthAgo);

  // Current streak
  const { data: streakRow } = await supabase
    .from('streaks')
    .select('current_streak')
    .eq('user_id', clientId)
    .maybeSingle();

  const clientData = {
    ...prof,
    latest_weight_kg: metrics?.weight_kg ?? prof.weight_kg ?? null,
    latest_body_fat: metrics?.body_fat ?? null,
    sessions_last_30_days: sessionCount || 0,
    current_streak: streakRow?.current_streak || 0,
  };

  const prompt = `You are writing a private client overview for a fitness coach.
Based on the following client data, write a concise 3-4 paragraph
professional summary that covers:
1. Who they are and their primary goal (be specific — if goal is
   'sport', name the sport and what they are training for)
2. Their starting point — current stats, experience level,
   any injuries or limitations to be aware of
3. Their schedule and availability — which days they can train,
   how many sessions per week, any equipment constraints
4. Nutrition context — diet style, restrictions, calorie targets
   if set
Write in second person addressed to the coach, not the client.
Be direct and factual. Use the client's actual name.
Client data: ${JSON.stringify(clientData)}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });
  const summary = (msg.content?.[0]?.text || '').trim();
  if (!summary) throw new Error('empty_summary');

  await supabase
    .from('coach_clients')
    .update({ client_summary: summary, client_summary_generated_at: new Date().toISOString() })
    .eq('coach_id', coachId)
    .eq('client_id', clientId);

  return summary;
}

// On-demand summary generation / regeneration for a coach viewing a client.
app.post('/api/coach/clients/:clientId/generate-summary', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const summary = await generateClientSummary(req.user.id, clientId);
    res.json({ summary, summary_generated_at: new Date().toISOString() });
  } catch(err) {
    console.error('[generate-summary]', err.message);
    res.status(500).json({ error: 'summary_failed' });
  }
});

// ── Coach setup — Stripe checkout for new coach plan ──
// ── Coach setup — activates trial immediately, NO Stripe at this step.
// Card is collected only after the 14-day trial expires (see /api/coach/create-checkout).
app.post('/api/coach/setup', requireAuth, async (req, res) => {
  try {
    const { title, bio, plan, billing } = req.body;
    if (!title) return res.status(400).json({ error: 'Missing title' });
    if (!plan || !COACH_PLAN_CONFIG[plan]) return res.status(400).json({ error: 'Invalid plan' });

    const planConfig = COACH_PLAN_CONFIG[plan];
    const userId = req.user.id;

    const updates = {
      account_type: 'coach',
      coach_plan: plan,
      coach_plan_status: 'trial',
      coach_trial_start: new Date().toISOString(),
      coach_commission_rate: planConfig.commissionRate,
      coach_bio: (bio || '').toString().slice(0, 200) || null,
      coach_title: (title || '').toString().slice(0, 100),
    };
    // Remember the billing preference for when the user hits Stripe at trial end.
    if (['monthly', 'annual'].includes(billing)) updates.coach_billing_preference = billing;

    const { error } = await supabase.from('profiles').update(updates).eq('id', userId);
    if (error) throw error;

    res.json({ ok: true, plan, status: 'trial' });
  } catch(err) {
    console.error('Coach setup error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Coach checkout — called only when the trial has expired (or user upgrades early).
// Creates a Stripe subscription session with NO trial (the in-app trial was already used).
app.post('/api/coach/create-checkout', requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const { plan, billing } = req.body || {};

    const { data: profile } = await supabase.from('profiles')
      .select('stripe_customer_id, name, coach_plan, coach_billing_preference').eq('id', req.user.id).maybeSingle();

    const chosenPlan = plan || profile?.coach_plan;
    const chosenBilling = billing || profile?.coach_billing_preference || 'annual';
    if (!chosenPlan || !COACH_PLAN_CONFIG[chosenPlan]) return res.status(400).json({ error: 'Invalid plan' });
    if (!['monthly','annual'].includes(chosenBilling)) return res.status(400).json({ error: 'Invalid billing' });

    const priceKey = `coach_${chosenPlan}_${chosenBilling}`;
    const priceId = STRIPE_PRICES[priceKey];
    if (!priceId) return res.status(400).json({ error: `Coach price ID not configured for ${priceKey}` });

    // Get or create Stripe customer
    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email, name: profile?.name || '', metadata: { user_id: req.user.id },
      });
      customerId = customer.id;
      await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', req.user.id);
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://klemforge.com';
    const appUrl = frontendUrl.replace(/\/$/, '') + '/app.html';

    const coachMetadata = {
      user_id: req.user.id,
      account_type: 'coach',
      coach_plan: chosenPlan,
      coach_billing: chosenBilling,
      coach_post_trial: 'true', // signals to webhook: don't reset coach_trial_start
    };

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${appUrl}?coach_payment=success`,
      cancel_url: `${appUrl}?coach_payment=cancelled`,
      metadata: coachMetadata,
      // trial already used — charge immediately
      subscription_data: { metadata: coachMetadata },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url, session_id: session.id });
  } catch(err) {
    console.error('Coach create-checkout error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Downgrade a coach account back to individual user (called from trial-expired paywall)
app.post('/api/coach/downgrade', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('profiles').update({
      account_type: 'user',
      coach_plan_status: 'cancelled',
    }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Coach profile ──────────────────────────────────────
app.get('/api/coach/profile', requireAuth, requireCoach, async (req, res) => {
  try {
    const { data } = await supabase.from('profiles')
      .select('account_type, coach_plan, coach_plan_status, coach_trial_start, coach_commission_rate, coach_bio, coach_title, coach_stripe_subscription_id, name')
      .eq('id', req.user.id).maybeSingle();
    res.json({ profile: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/coach/profile', requireAuth, requireCoach, async (req, res) => {
  try {
    const { bio, title } = req.body;
    const update = {};
    if (typeof bio === 'string') update.coach_bio = bio.slice(0, 500);
    if (typeof title === 'string') update.coach_title = title.slice(0, 100);
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update' });
    await supabase.from('profiles').update(update).eq('id', req.user.id);
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Client management ──────────────────────────────────
app.get('/api/coach/clients', requireAuth, requireCoach, async (req, res) => {
  try {
    const { data: links } = await supabase
      .from('coach_clients')
      .select('id, client_id, invited_email, status, connected_at, created_at')
      .eq('coach_id', req.user.id)
      .neq('status', 'disconnected')
      .order('created_at', { ascending: false });
    const rows = links || [];
    const clientIds = rows.filter(r => r.client_id).map(r => r.client_id);
    let profilesById = {};
    if (clientIds.length) {
      const { data: profiles } = await supabase.from('profiles')
        .select('id, name, goal, experience, subscription_tier').in('id', clientIds);
      for (const p of (profiles || [])) profilesById[p.id] = p;
    }
    // Last active per client — most recent session_log (logged_at is YYYY-MM-DD).
    // NOTE: bounded to the last 180 days of client logs. "first occurrence wins" below
    // still yields each client's most-recent date; a client with zero logs in the
    // window simply reports last_active=null (matches the no-logs display anyway).
    // This prevents the query from scanning every client's entire history at scale.
    let lastActiveById = {};
    if (clientIds.length) {
      const since180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const { data: logs } = await supabase.from('session_logs')
        .select('user_id, logged_at')
        .in('user_id', clientIds)
        .gte('logged_at', since180)
        .order('logged_at', { ascending: false });
      for (const log of (logs || [])) {
        if (!lastActiveById[log.user_id]) lastActiveById[log.user_id] = log.logged_at;
      }
    }
    const clients = rows.map(r => ({
      connection_id: r.id,
      client_id: r.client_id,
      invited_email: r.invited_email,
      status: r.status,
      connected_at: r.connected_at,
      created_at: r.created_at,
      profile: r.client_id ? (profilesById[r.client_id] || null) : null,
      last_active: r.client_id ? (lastActiveById[r.client_id] || null) : null,
    }));
    res.json({ clients });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/coach/clients/invite', requireAuth, requireCoach, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

    // Seat-limit check (active + pending count toward limit)
    const plan = req.coachProfile.coach_plan;
    const limit = COACH_PLAN_CONFIG[plan]?.seatLimit ?? 10;
    const used = await countActiveClients(req.user.id);
    if (used >= limit) {
      return res.status(403).json({ error: 'seat_limit', plan, limit, used });
    }

    // Does the email match an existing user? `profiles` has NO email column —
    // it must come from auth.users via auth.admin.listUsers(). DO NOT change this to
    // `profiles.ilike('email', …)` — that returns null for every real user and breaks
    // every invite silently. See decisions.md: "PERMANENT: Coach invite existing-user lookup".
    const cleanEmail = email.trim().toLowerCase();
    let existingUser = null;
    try {
      const { data: authList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      const matchedAuthUser = (authList?.users || []).find(
        u => u.email?.toLowerCase() === cleanEmail
      );
      if (matchedAuthUser) {
        const { data: profileRow } = await supabase
          .from('profiles')
          .select('id, name')
          .eq('id', matchedAuthUser.id)
          .maybeSingle();
        if (profileRow) existingUser = profileRow;
      }
    } catch(e) {
      console.warn('[invite] auth.admin.listUsers failed:', e.message);
    }
    console.log('[invite] existingUser lookup result:', existingUser);

    let newLink = null;

    if (existingUser) {
      // Block coach-to-coach invites — a coach account cannot be a client of another coach.
      const { data: inviteeProfile } = await supabase
        .from('profiles')
        .select('account_type')
        .eq('id', existingUser.id)
        .maybeSingle();

      if (inviteeProfile?.account_type === 'coach') {
        return res.status(409).json({
          error: 'cannot_invite_coach',
          message: 'Coach accounts cannot be invited as clients.'
        });
      }

      // Block if the client already has an active coach (any coach, not just this one)
      const { data: activeCoach } = await supabase.from('coach_clients')
        .select('id, coach_id').eq('client_id', existingUser.id).eq('status', 'active').maybeSingle();
      if (activeCoach && activeCoach.coach_id !== req.user.id) {
        return res.status(409).json({
          error: 'already_has_coach',
          message: 'This user already has an active coach.'
        });
      }

      // Look for any prior link between this coach and this client
      const { data: existing } = await supabase.from('coach_clients')
        .select('id, status').eq('coach_id', req.user.id).eq('client_id', existingUser.id).maybeSingle();

      if (existing) {
        if (existing.status === 'pending') {
          return res.json({ type: 'existing', message: 'Invite already sent.', connection_id: existing.id });
        }
        if (existing.status === 'active') {
          return res.status(409).json({ error: 'already_connected', message: 'You are already connected with this client.' });
        }
        if (existing.status === 'disconnected') {
          // Re-invite: update the existing row in place rather than insert a new one
          const { data: updated, error: updateErr } = await supabase.from('coach_clients').update({
            status: 'pending',
            disconnected_at: null,
            created_at: new Date().toISOString(),
            coach_seen: false,
          }).eq('id', existing.id).select().maybeSingle();
          if (updateErr) throw updateErr;
          newLink = updated;
          console.log('[invite] re-invited disconnected coach_clients row:', newLink?.id);
        }
      }

      if (!newLink) {
        const insertRow = {
          coach_id: req.user.id,
          client_id: existingUser.id,
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        const { data: inserted, error: insertErr } = await supabase
          .from('coach_clients').insert(insertRow).select().maybeSingle();
        if (insertErr) throw insertErr;
        newLink = inserted;
        console.log('[invite] coach_clients insert result:', JSON.stringify(inserted));
        console.log('[invite] client_id stored:', insertRow.client_id);
        console.log('[invite] invited_email stored:', insertRow.invited_email);
        console.log('[invite] created coach_clients row:', newLink?.id, 'for client', existingUser.id);
      }

      await sendPushToUser(
        existingUser.id,
        'New coach request',
        `A FORGE coach has requested to connect with you.`,
        `/app.html?coach_request=${newLink.id}`
      ).catch(() => {});
      return res.json({ type: 'existing', message: 'Connection request sent.', connection_id: newLink.id });
    } else {
      // No existing user — invite by email
      const { data: existingInvite } = await supabase.from('coach_clients')
        .select('id').eq('coach_id', req.user.id).eq('invited_email', cleanEmail)
        .neq('status', 'disconnected').maybeSingle();
      if (existingInvite) return res.status(400).json({ error: 'already_invited', status: 'pending' });

      const insertRow = {
        coach_id: req.user.id,
        invited_email: cleanEmail,
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      const { data: inserted, error: insertErr } = await supabase
        .from('coach_clients').insert(insertRow).select().maybeSingle();
      if (insertErr) throw insertErr;
      newLink = inserted;
      console.log('[invite] coach_clients insert result:', JSON.stringify(inserted));
      console.log('[invite] client_id stored:', insertRow.client_id);
      console.log('[invite] invited_email stored:', insertRow.invited_email);
      console.log('[invite] created coach_clients row:', newLink?.id, 'for email', cleanEmail);
      // Email send is wired up to existing email system when available.
      // For now we log and rely on the recipient signing up — they'll see the invite on first login.
      console.log(`[coach invite] new-user invite recorded for ${cleanEmail} from coach ${req.user.id}`);
      return res.json({ type: 'new', message: 'Invitation recorded. They\'ll see it when they join FORGE.', connection_id: newLink.id });
    }
  } catch(err) {
    console.error('Coach invite error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/coach/clients/:clientId', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    // Find the link — clientId param may be a profile id OR a connection id
    const { data: link } = await supabase.from('coach_clients')
      .select('id, client_id').eq('coach_id', req.user.id)
      .or(`client_id.eq.${clientId},id.eq.${clientId}`).neq('status', 'disconnected').maybeSingle();
    if (!link) return res.status(404).json({ error: 'Not found' });
    await supabase.from('coach_clients').update({
      status: 'disconnected', disconnected_at: new Date().toISOString()
    }).eq('id', link.id);
    if (link.client_id) {
      await sendPushToUser(link.client_id, 'Coach disconnected',
        'Your coach has ended the connection. Your training data stays yours.',
        '/app.html?panel=account').catch(() => {});
    }
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Client data — coach reads client data ─────────────
app.get('/api/coach/clients/:clientId/overview', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }

    const now = new Date();
    // Week starts Monday — use date strings since logged_at is YYYY-MM-DD
    const dayOfWeek = now.getDay(); // 0=Sun
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStartDate = new Date(now);
    weekStartDate.setDate(now.getDate() - daysFromMonday);
    const weekStartStr = weekStartDate.toISOString().split('T')[0];
    const monthStartStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const thirtyDaysAgoStr = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [lastSessionRes, weekSessionsRes, prsRes, metricsRes, streakRes, profileRes] = await Promise.all([
      supabase.from('session_logs').select('id, logged_at, day_label, exercises').eq('user_id', clientId).order('logged_at', { ascending: false }).limit(1),
      supabase.from('session_logs').select('id, logged_at, day_label, exercises').eq('user_id', clientId).gte('logged_at', weekStartStr).order('logged_at', { ascending: false }),
      supabase.from('personal_records').select('id', { count: 'exact', head: true }).eq('user_id', clientId).gte('achieved_at', monthStartStr),
      supabase.from('body_metrics').select('*').eq('user_id', clientId).gte('logged_at', thirtyDaysAgoStr).order('logged_at', { ascending: true }),
      supabase.from('streaks').select('current_streak, longest_streak').eq('user_id', clientId).maybeSingle(),
      supabase.from('profiles').select('name, goal, experience, days_per_week').eq('id', clientId).maybeSingle(),
    ]);

    const weekSessions = weekSessionsRes.data || [];

    // Streak fallback — if no streaks row, count consecutive days back from today using session_logs
    let currentStreak = streakRes.data?.current_streak ?? null;
    if (currentStreak === null || currentStreak === undefined) {
      const { data: allLogs } = await supabase.from('session_logs')
        .select('logged_at').eq('user_id', clientId).order('logged_at', { ascending: false }).limit(120);
      const dateSet = new Set((allLogs || []).map(l => (l.logged_at + '').split('T')[0]));
      let streak = 0;
      const cursor = new Date();
      // allow today OR yesterday as the starting anchor so a streak doesn't break before today is logged
      const todayStr = cursor.toISOString().split('T')[0];
      if (!dateSet.has(todayStr)) cursor.setDate(cursor.getDate() - 1);
      while (dateSet.has(cursor.toISOString().split('T')[0])) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }
      currentStreak = streak;
    }

    // Upcoming sessions — pull from active plan
    let upcoming = [];
    try {
      const { data: plan } = await supabase.from('plans')
        .select('workout_plan').eq('user_id', clientId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const days = plan?.workout_plan?.days || plan?.workout_plan || [];
      if (Array.isArray(days)) upcoming = days.slice(0, 3);
    } catch(e) { /* plan structure may vary */ }

    // AI client summary (loaded with the overview so it renders in one call)
    const { data: connRow } = await supabase.from('coach_clients')
      .select('client_summary, client_summary_generated_at')
      .eq('coach_id', req.user.id).eq('client_id', clientId).eq('status', 'active').maybeSingle();

    res.json({
      profile: profileRes.data,
      sessions_this_week: weekSessions.length,
      recent_sessions: weekSessions,
      current_streak: currentStreak,
      last_session: lastSessionRes.data?.[0] || null,
      prs_this_month: prsRes.count || 0,
      body_metrics: metricsRes.data || [],
      upcoming_sessions: upcoming,
      summary: connRow?.client_summary || null,
      summary_generated_at: connRow?.client_summary_generated_at || null,
    });
  } catch(err) {
    console.error('Coach overview error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/api/coach/clients/:clientId/plan', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { data: plan } = await supabase.from('plans')
      .select('workout_plan, generated_at')
      .eq('user_id', clientId)
      .order('generated_at', { ascending: false })
      .limit(1).maybeSingle();
    res.json({ plan: plan?.workout_plan || null });
  } catch(err) {
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/coach/clients/:clientId/ai-activity', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const [convsRes, weeklyRes, monthlyRes, settingsRes] = await Promise.all([
      supabase.from('chat_conversations').select('*').eq('user_id', clientId).order('created_at', { ascending: false }).limit(50),
      supabase.from('weekly_reviews').select('*').eq('user_id', clientId).order('created_at', { ascending: false }).limit(12),
      supabase.from('monthly_reviews').select('*').eq('user_id', clientId).order('generated_at', { ascending: false }).limit(12),
      supabase.from('coach_ai_review_settings').select('*').eq('coach_id', req.user.id).eq('client_id', clientId).maybeSingle(),
    ]);
    res.json({
      conversations: convsRes.data || [],
      weekly_reviews: weeklyRes.data || [],
      monthly_reviews: monthlyRes.data || [],
      review_settings: settingsRes.data || {
        post_workout_checkin_enabled: true,
        weekly_review_enabled: true,
        monthly_review_enabled: true,
      },
    });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/coach/clients/:clientId/notes', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { data } = await supabase.from('coach_notes')
      .select('*').eq('coach_id', req.user.id).eq('client_id', clientId).maybeSingle();
    res.json({ notes: data || null });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/coach/clients/:clientId/notes', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { content } = req.body;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { data, error } = await supabase.from('coach_notes').upsert({
      coach_id: req.user.id, client_id: clientId, content: content || '',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'coach_id,client_id' }).select().maybeSingle();
    if (error) throw error;
    res.json({ ok: true, notes: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Coach session feedback ────────────────────────────
app.get('/api/coach/clients/:clientId/feedback', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { data, error } = await supabase.from('coach_session_feedback')
      .select('id, feedback_text, session_log_id, is_general, created_at, updated_at')
      .eq('coach_id', req.user.id).eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ feedback: data || [] });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/coach/clients/:clientId/feedback', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { feedback_text, session_log_id, is_general, visible_to_client } = req.body;
    const text = (feedback_text || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'empty_feedback' });
    if (text.length > 1000) return res.status(400).json({ error: 'too_long' });
    const row = {
      coach_id: req.user.id,
      client_id: clientId,
      feedback_text: text,
      session_log_id: session_log_id || null,
      is_general: !!is_general,
      visible_to_client: !!visible_to_client,
    };
    const { data, error } = await supabase.from('coach_session_feedback').insert(row).select().maybeSingle();
    if (error) throw error;
    res.json({ ok: true, feedback: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/coach/feedback/:feedbackId', requireAuth, requireCoach, async (req, res) => {
  try {
    const { feedbackId } = req.params;
    const { feedback_text, visible_to_client } = req.body || {};
    const { data: existing } = await supabase.from('coach_session_feedback')
      .select('id, coach_id').eq('id', feedbackId).maybeSingle();
    if (!existing || existing.coach_id !== req.user.id) {
      return res.status(404).json({ error: 'not_found' });
    }
    const patch = { updated_at: new Date().toISOString() };
    if (typeof feedback_text === 'string') {
      const text = feedback_text.trim();
      if (!text) return res.status(400).json({ error: 'empty_feedback' });
      if (text.length > 1000) return res.status(400).json({ error: 'too_long' });
      patch.feedback_text = text;
    }
    if (typeof visible_to_client === 'boolean') {
      patch.visible_to_client = visible_to_client;
    }
    if (Object.keys(patch).length === 1) return res.status(400).json({ error: 'no_changes' });
    const { data, error } = await supabase.from('coach_session_feedback')
      .update(patch).eq('id', feedbackId).select().maybeSingle();
    if (error) throw error;
    res.json({ ok: true, feedback: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/coach/feedback/:feedbackId', requireAuth, requireCoach, async (req, res) => {
  try {
    const { feedbackId } = req.params;
    const { data: existing } = await supabase.from('coach_session_feedback')
      .select('id, coach_id').eq('id', feedbackId).maybeSingle();
    if (!existing || existing.coach_id !== req.user.id) {
      return res.status(404).json({ error: 'not_found' });
    }
    const { error } = await supabase.from('coach_session_feedback').delete().eq('id', feedbackId);
    if (error) throw error;
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Client-facing: feedback shared by my coach ────────
app.get('/api/my-coach-feedback', requireAuth, async (req, res) => {
  try {
    const { data: link } = await supabase.from('coach_clients')
      .select('coach_id').eq('client_id', req.user.id).eq('status', 'active').maybeSingle();
    if (!link) return res.json({ feedback: [] });
    const { data, error } = await supabase.from('coach_session_feedback')
      .select('id, feedback_text, session_log_id, is_general, created_at, updated_at')
      .eq('coach_id', link.coach_id).eq('client_id', req.user.id).eq('visible_to_client', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const items = data || [];
    const sessionIds = items.map(f => f.session_log_id).filter(Boolean);
    let sessionLabelById = {};
    if (sessionIds.length) {
      const { data: sessions } = await supabase.from('session_logs')
        .select('id, day_label, logged_at').in('id', sessionIds);
      for (const s of (sessions || [])) sessionLabelById[s.id] = { day_label: s.day_label, logged_at: s.logged_at };
    }
    res.json({
      feedback: items.map(f => ({
        ...f,
        session_label: f.session_log_id ? (sessionLabelById[f.session_log_id]?.day_label || null) : null,
        session_logged_at: f.session_log_id ? (sessionLabelById[f.session_log_id]?.logged_at || null) : null,
      })),
    });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Coach ↔ Client messaging ──────────────────────────
app.get('/api/my-coach-messages', requireAuth, async (req, res) => {
  try {
    const { data: link } = await supabase.from('coach_clients')
      .select('coach_id').eq('client_id', req.user.id).eq('status', 'active').maybeSingle();
    if (!link) return res.json({ messages: [], coach_id: null });
    // Cap to the most recent 300 messages (fetch newest-first, return oldest-first
    // for display) so a long-running thread can't pull an unbounded row count.
    const { data, error } = await supabase.from('coach_messages')
      .select('id, sender_role, message_text, read_at, created_at')
      .eq('coach_id', link.coach_id).eq('client_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;
    // Mark unread coach-sent messages as read
    await supabase.from('coach_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('coach_id', link.coach_id).eq('client_id', req.user.id)
      .eq('sender_role', 'coach').is('read_at', null);
    res.json({ messages: (data || []).reverse(), coach_id: link.coach_id });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/my-coach-messages', requireAuth, async (req, res) => {
  try {
    const { data: link } = await supabase.from('coach_clients')
      .select('coach_id').eq('client_id', req.user.id).eq('status', 'active').maybeSingle();
    if (!link) return res.status(403).json({ error: 'no_coach' });
    const text = (req.body?.message_text || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'empty_message' });
    if (text.length > 2000) return res.status(400).json({ error: 'too_long' });
    const { data, error } = await supabase.from('coach_messages').insert({
      coach_id: link.coach_id, client_id: req.user.id,
      sender_role: 'client', message_text: text,
    }).select().maybeSingle();
    if (error) throw error;
    // Push to coach
    const { data: clientProfile } = await supabase.from('profiles').select('name').eq('id', req.user.id).maybeSingle();
    const clientName = clientProfile?.name || 'Your client';
    await sendPushToUser(link.coach_id, 'New client message',
      `${clientName} sent you a message`,
      '/app.html?panel=clients').catch(() => {});
    res.json({ ok: true, message: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/coach/clients/:clientId/messages', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    // Cap to the most recent 300 messages (newest-first fetch, oldest-first display).
    const { data, error } = await supabase.from('coach_messages')
      .select('id, sender_role, message_text, read_at, created_at')
      .eq('coach_id', req.user.id).eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;
    // Mark unread client-sent messages as read
    await supabase.from('coach_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('coach_id', req.user.id).eq('client_id', clientId)
      .eq('sender_role', 'client').is('read_at', null);
    res.json({ messages: (data || []).reverse() });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/coach/clients/:clientId/messages', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const text = (req.body?.message_text || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'empty_message' });
    if (text.length > 2000) return res.status(400).json({ error: 'too_long' });
    const { data, error } = await supabase.from('coach_messages').insert({
      coach_id: req.user.id, client_id: clientId,
      sender_role: 'coach', message_text: text,
    }).select().maybeSingle();
    if (error) throw error;
    const coachName = req.coachProfile?.name || 'Your coach';
    await sendPushToUser(clientId, 'Coach replied',
      `${coachName} replied to your message`,
      '/app.html?panel=my-coach').catch(() => {});
    res.json({ ok: true, message: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Manual coach reviews (when AI review disabled) ────
app.post('/api/coach/clients/:clientId/manual-review', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { review_type, review_content, review_period } = req.body || {};
    if (!['weekly', 'monthly'].includes(review_type)) return res.status(400).json({ error: 'bad_type' });
    const content = (review_content || '').toString().trim();
    if (!content) return res.status(400).json({ error: 'empty_content' });
    if (content.length > 2000) return res.status(400).json({ error: 'too_long' });
    const period = (review_period || '').toString().slice(0, 32) || null;

    // Upsert on (coach_id, client_id, review_type, review_period) — find first, then update or insert
    const { data: existing } = await supabase.from('coach_manual_reviews')
      .select('id').eq('coach_id', req.user.id).eq('client_id', clientId)
      .eq('review_type', review_type).eq('review_period', period).maybeSingle();
    let row;
    if (existing) {
      const { data, error } = await supabase.from('coach_manual_reviews')
        .update({ review_content: content, updated_at: new Date().toISOString() })
        .eq('id', existing.id).select().maybeSingle();
      if (error) throw error;
      row = data;
    } else {
      const { data, error } = await supabase.from('coach_manual_reviews').insert({
        coach_id: req.user.id, client_id: clientId,
        review_type, review_content: content, review_period: period,
      }).select().maybeSingle();
      if (error) throw error;
      row = data;
    }
    // Push the client so they see it
    await sendPushToUser(clientId, 'Coach review',
      `Your coach posted a ${review_type} review`,
      '/app.html?panel=coach').catch(() => {});
    res.json({ ok: true, review: row });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/coach/clients/:clientId/manual-reviews', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { data, error } = await supabase.from('coach_manual_reviews')
      .select('id, review_type, review_content, review_period, created_at, updated_at')
      .eq('coach_id', req.user.id).eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ reviews: data || [] });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/my-manual-reviews', requireAuth, async (req, res) => {
  try {
    const { data: link } = await supabase.from('coach_clients')
      .select('coach_id').eq('client_id', req.user.id).eq('status', 'active').maybeSingle();
    if (!link) return res.json({ reviews: [] });
    const { data, error } = await supabase.from('coach_manual_reviews')
      .select('id, review_type, review_content, review_period, created_at, updated_at')
      .eq('coach_id', link.coach_id).eq('client_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ reviews: data || [] });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Notifications: unread counts ──────────────────────
app.get('/api/notifications/unread-counts', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [profileRes, msgsRes, fbRes, revRes, coachReqRes] = await Promise.all([
      supabase.from('profiles').select('account_type, coach_plan_status').eq('id', uid).maybeSingle(),
      supabase.from('coach_messages').select('id', { count: 'exact', head: true })
        .eq('client_id', uid).eq('sender_role', 'coach').is('read_at', null),
      supabase.from('coach_session_feedback').select('id', { count: 'exact', head: true })
        .eq('client_id', uid).eq('visible_to_client', true).eq('seen_by_client', false),
      supabase.from('coach_manual_reviews').select('id', { count: 'exact', head: true })
        .eq('client_id', uid).eq('seen_by_client', false),
      supabase.from('coach_clients').select('id', { count: 'exact', head: true })
        .eq('client_id', uid).eq('status', 'pending'),
    ]);

    const out = {
      coach_messages_unread: msgsRes.count || 0,
      coach_feedback_unread: fbRes.count || 0,
      coach_review_unread: revRes.count || 0,
      coach_requests_pending: coachReqRes.count || 0,
    };

    const profile = profileRes.data;
    const isCoach = profile?.account_type === 'coach' && ['active', 'trial'].includes(profile?.coach_plan_status);

    if (isCoach) {
      const fortyEightHoursAgoIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const fortyEightHoursAgoDateStr = fortyEightHoursAgoIso.split('T')[0];

      // Active client IDs to scope activity queries
      const { data: links } = await supabase.from('coach_clients')
        .select('client_id').eq('coach_id', uid).eq('status', 'active');
      const clientIds = (links || []).map(l => l.client_id).filter(Boolean);

      const [coachMsgsRes, newConnRes, sessionsRes, prsRes, metricsRes, convRes, weeklyRes, monthlyRes, manualRes] = await Promise.all([
        supabase.from('coach_messages').select('client_id')
          .eq('coach_id', uid).eq('sender_role', 'client').is('read_at', null),
        supabase.from('coach_clients').select('id', { count: 'exact', head: true })
          .eq('coach_id', uid).eq('status', 'active').eq('coach_seen', false),
        clientIds.length
          ? supabase.from('session_logs').select('user_id').in('user_id', clientIds).gte('logged_at', fortyEightHoursAgoDateStr)
          : Promise.resolve({ data: [] }),
        clientIds.length
          ? supabase.from('personal_records').select('user_id').in('user_id', clientIds).gte('achieved_at', fortyEightHoursAgoIso)
          : Promise.resolve({ data: [] }),
        clientIds.length
          ? supabase.from('body_metrics').select('user_id').in('user_id', clientIds).gte('logged_at', fortyEightHoursAgoIso)
          : Promise.resolve({ data: [] }),
        clientIds.length
          ? supabase.from('chat_conversations').select('user_id').in('user_id', clientIds).gte('created_at', fortyEightHoursAgoIso)
          : Promise.resolve({ data: [] }),
        clientIds.length
          ? supabase.from('weekly_reviews').select('user_id').in('user_id', clientIds).gte('created_at', fortyEightHoursAgoIso)
          : Promise.resolve({ data: [] }),
        clientIds.length
          ? supabase.from('monthly_reviews').select('user_id').in('user_id', clientIds).gte('generated_at', fortyEightHoursAgoIso)
          : Promise.resolve({ data: [] }),
        clientIds.length
          ? supabase.from('coach_manual_reviews').select('client_id').eq('coach_id', uid).in('client_id', clientIds).gte('created_at', fortyEightHoursAgoIso)
          : Promise.resolve({ data: [] }),
      ]);

      const byClient = {};
      for (const row of (coachMsgsRes.data || [])) {
        byClient[row.client_id] = (byClient[row.client_id] || 0) + 1;
      }

      const activityByClient = {};
      const bump = (cid, key) => {
        if (!cid) return;
        if (!activityByClient[cid]) activityByClient[cid] = { workouts: 0, prs: 0, metrics: 0, ai: 0 };
        activityByClient[cid][key]++;
      };
      for (const r of (sessionsRes.data || [])) bump(r.user_id, 'workouts');
      for (const r of (prsRes.data || [])) bump(r.user_id, 'prs');
      for (const r of (metricsRes.data || [])) bump(r.user_id, 'metrics');
      for (const r of (convRes.data || [])) bump(r.user_id, 'ai');
      for (const r of (weeklyRes.data || [])) bump(r.user_id, 'ai');
      for (const r of (monthlyRes.data || [])) bump(r.user_id, 'ai');
      for (const r of (manualRes.data || [])) bump(r.client_id, 'ai');

      out.client_messages_unread = (coachMsgsRes.data || []).length;
      out.client_messages_by_client = byClient;
      out.new_client_connections = newConnRes.count || 0;
      out.client_new_activity = activityByClient;
    }

    res.json(out);
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/notifications/mark-seen', requireAuth, async (req, res) => {
  try {
    const { type } = req.body || {};
    const uid = req.user.id;
    if (type === 'coach_messages') {
      await supabase.from('coach_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('client_id', uid).eq('sender_role', 'coach').is('read_at', null);
    } else if (type === 'coach_feedback') {
      await supabase.from('coach_session_feedback')
        .update({ seen_by_client: true })
        .eq('client_id', uid).eq('seen_by_client', false);
    } else if (type === 'coach_review') {
      await supabase.from('coach_manual_reviews')
        .update({ seen_by_client: true })
        .eq('client_id', uid).eq('seen_by_client', false);
    } else if (type === 'client_connection') {
      await supabase.from('coach_clients')
        .update({ coach_seen: true })
        .eq('coach_id', uid).eq('status', 'active').eq('coach_seen', false);
    } else {
      return res.status(400).json({ error: 'bad_type' });
    }
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/notifications/mark-client-messages-seen/:clientId', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    await supabase.from('coach_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('coach_id', req.user.id).eq('client_id', clientId)
      .eq('sender_role', 'client').is('read_at', null);
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/coach/clients/:clientId/review-settings', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { post_workout_checkin_enabled, weekly_review_enabled, monthly_review_enabled } = req.body;
    const row = {
      coach_id: req.user.id,
      client_id: clientId,
      updated_at: new Date().toISOString(),
    };
    if (typeof post_workout_checkin_enabled === 'boolean') row.post_workout_checkin_enabled = post_workout_checkin_enabled;
    if (typeof weekly_review_enabled === 'boolean') row.weekly_review_enabled = weekly_review_enabled;
    if (typeof monthly_review_enabled === 'boolean') row.monthly_review_enabled = monthly_review_enabled;
    const { data, error } = await supabase.from('coach_ai_review_settings')
      .upsert(row, { onConflict: 'coach_id,client_id' }).select().maybeSingle();
    if (error) throw error;
    res.json({ ok: true, settings: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Programmes ────────────────────────────────────────
app.get('/api/coach/programmes', requireAuth, requireCoach, async (req, res) => {
  try {
    const { data } = await supabase.from('coach_programmes')
      .select('*').eq('coach_id', req.user.id).order('updated_at', { ascending: false });
    res.json({ programmes: data || [] });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/coach/programmes', requireAuth, requireCoach, async (req, res) => {
  try {
    const { client_id, name, programme_data, nutrition_data, programme_type, is_template } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const ptype = programme_type || 'workout';

    if (client_id && !is_template) {
      if (!await verifyClientConnection(req.user.id, client_id)) {
        return res.status(403).json({ error: 'no_connection' });
      }
    }

    const row = {
      coach_id: req.user.id,
      client_id: client_id || null,
      name: name.slice(0, 200),
      is_template: !!is_template,
      programme_type: ptype,
      programme_data: programme_data || {},
      nutrition_data: nutrition_data || null,
      assigned_at: (client_id && !is_template) ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('coach_programmes').insert(row).select().maybeSingle();
    if (error) throw error;

    // Workout assignment → write workout_plan into the client's live plan
    if (client_id && !is_template && ptype !== 'nutrition') {
      await sendPushToUser(client_id, 'New programme assigned',
        `Your coach has assigned you a new programme: ${name}`,
        '/app.html?panel=workout').catch(() => {});

      // Also update the client's actual plan so it shows in their workout panel
      const coachPlanData = {
        days: (programme_data?.sessions || []).map((s, i) => ({
          day_index: i,
          day_name: s.name || `Day ${i + 1}`,
          label: s.name || `Day ${i + 1}`,
          coach_note: s.note || null,
          exercises: (s.exercises || []).map(e => ({
            name: e.name,
            sets: e.sets,
            reps: e.reps,
            rest: e.rpe || e.weight || null,
            note: `${e.rpe ? 'RPE ' + e.rpe : ''}${e.weight ? e.weight : ''}`.trim() || null,
          }))
        })),
        coach_assigned: true,
        coach_name: req.coachProfile.name || 'Your coach',
        programme_name: name,
      };

      // Get existing plan to update or create new
      const { data: existingPlan } = await supabase.from('plans')
        .select('id').eq('user_id', client_id)
        .order('generated_at', { ascending: false }).limit(1).maybeSingle();

      if (existingPlan?.id) {
        await supabase.from('plans').update({
          workout_plan: coachPlanData,
          translations: {},
          generated_at: new Date().toISOString(),
        }).eq('id', existingPlan.id);
      } else {
        await supabase.from('plans').insert({
          user_id: client_id,
          workout_plan: coachPlanData,
          generated_at: new Date().toISOString(),
        });
      }
    }

    // Nutrition assignment → write nutrition_plan into the client's live plan
    if (client_id && !is_template && nutrition_data && (ptype === 'nutrition' || ptype === 'both')) {
      const coachName = req.coachProfile.coach_title || req.coachProfile.name || 'Your coach';
      const { data: existingPlanN } = await supabase.from('plans')
        .select('id, nutrition_plan').eq('user_id', client_id)
        .order('generated_at', { ascending: false }).limit(1).maybeSingle();
      const prevN = existingPlanN?.nutrition_plan || null;
      // Preserve the original AI nutrition so "Reset to AI plan" can restore it.
      const aiBackup = prevN ? (prevN.coach_assigned ? (prevN._ai_backup || null) : prevN) : null;
      const liveNutrition = {
        ...nutrition_data,
        coach_assigned: true,
        coach_name: coachName,
        assigned_at: new Date().toISOString(),
        _ai_backup: aiBackup,
      };
      if (existingPlanN?.id) {
        await supabase.from('plans').update({
          nutrition_plan: liveNutrition,
          translations: {},
          generated_at: new Date().toISOString(),
        }).eq('id', existingPlanN.id);
      } else {
        await supabase.from('plans').insert({
          user_id: client_id,
          nutrition_plan: liveNutrition,
          generated_at: new Date().toISOString(),
        });
      }
      await sendPushToUser(client_id, 'Nutrition plan updated',
        'Your coach has updated your nutrition plan',
        '/app.html?panel=nutrition').catch(() => {});
    }

    res.json({ ok: true, programme: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// FIX 7: generate a weekly shopping list from a coach-built nutrition plan's meals.
// Called from the coach nutrition builder when the "Include shopping list" toggle is on.
// Returns plain-text grouped list which is stored on nutrition_data.shopping_list and
// surfaced in the client's Food panel.
app.post('/api/coach/generate-shopping-list', requireAuth, requireCoach, async (req, res) => {
  try {
    const { meals, client_name } = req.body || {};
    if (!Array.isArray(meals) || !meals.length) {
      return res.status(400).json({ error: 'no_meals', message: 'No meals to build a shopping list from.' });
    }
    const mealsForPrompt = meals.map(m => ({
      name: m.name || '',
      foods: m.foods || m.note || m.notes || '',
      kcal: m.kcal != null ? m.kcal : m.calories,
      protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g,
    }));
    const prompt = `Based on these meals for a client's weekly nutrition plan, generate a practical weekly shopping list grouped by category (Proteins, Vegetables, Fruits, Grains/Carbs, Dairy, Fats/Oils, Other). Assume a full 7-day week and be specific with quantities where possible. Return ONLY the shopping list as plain text: each category as an UPPERCASE heading on its own line, followed by "- item (quantity)" bullet lines. No preamble, no closing remarks.\n\nMeals: ${JSON.stringify(mealsForPrompt)}`;
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const shopping_list = (message.content?.[0]?.text || '').trim();
    if (!shopping_list) return res.status(500).json({ error: 'generation_failed' });
    res.json({ shopping_list });
  } catch (err) {
    console.error('generate-shopping-list error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/coach/programmes/:programmeId', requireAuth, requireCoach, async (req, res) => {
  try {
    const { programmeId } = req.params;
    const { name, programme_data } = req.body;
    const update = { updated_at: new Date().toISOString() };
    if (typeof name === 'string') update.name = name.slice(0, 200);
    if (programme_data) update.programme_data = programme_data;
    const { data, error } = await supabase.from('coach_programmes')
      .update(update).eq('id', programmeId).eq('coach_id', req.user.id).select().maybeSingle();
    if (error) throw error;
    if (data?.client_id) {
      await sendPushToUser(data.client_id, 'Programme updated',
        'Your coach has updated your programme.', '/app.html?panel=workout').catch(() => {});

      // Update client's actual plan
      if (programme_data) {
        const updatedPlanData = {
          days: (programme_data?.sessions || []).map((s, i) => ({
            day_index: i,
            day_name: s.name || `Day ${i + 1}`,
            label: s.name || `Day ${i + 1}`,
            coach_note: s.note || null,
            exercises: (s.exercises || []).map(e => ({
              name: e.name, sets: e.sets, reps: e.reps,
              rest: e.rpe || e.weight || null,
            }))
          })),
          coach_assigned: true,
          coach_name: req.coachProfile.name || 'Your coach',
          programme_name: data.name,
        };
        const { data: existingPlan } = await supabase.from('plans')
          .select('id').eq('user_id', data.client_id)
          .order('generated_at', { ascending: false }).limit(1).maybeSingle();
        if (existingPlan?.id) {
          await supabase.from('plans').update({
            workout_plan: updatedPlanData, translations: {},
            generated_at: new Date().toISOString(),
          }).eq('id', existingPlan.id);
        }
      }
    }
    res.json({ ok: true, programme: data });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/coach/programmes/:programmeId', requireAuth, requireCoach, async (req, res) => {
  try {
    const { programmeId } = req.params;
    await supabase.from('coach_programmes')
      .delete().eq('id', programmeId).eq('coach_id', req.user.id);
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// Returns the client's current live nutrition plan (coach-assigned or AI).
app.get('/api/coach/clients/:clientId/nutrition-plan', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { data: planRow } = await supabase.from('plans')
      .select('nutrition_plan').eq('user_id', clientId)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle();
    res.json({ nutrition_plan: planRow?.nutrition_plan || null });
  } catch(err) {
    console.error('[nutrition-plan GET]', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// Restores the client's AI nutrition plan and removes the coach's nutrition programme.
app.post('/api/coach/clients/:clientId/reset-nutrition', requireAuth, requireCoach, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!await verifyClientConnection(req.user.id, clientId)) {
      return res.status(403).json({ error: 'no_connection' });
    }
    const { data: planRow } = await supabase.from('plans')
      .select('id, nutrition_plan').eq('user_id', clientId)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle();
    const restored = planRow?.nutrition_plan?._ai_backup || null;
    if (planRow?.id) {
      await supabase.from('plans').update({
        nutrition_plan: restored,
        translations: {},
        generated_at: new Date().toISOString(),
      }).eq('id', planRow.id);
    }
    await supabase.from('coach_programmes')
      .delete().eq('coach_id', req.user.id).eq('client_id', clientId).eq('programme_type', 'nutrition');
    await sendPushToUser(clientId, 'Nutrition plan reset',
      'Your coach reset your nutrition plan to the AI plan.',
      '/app.html?panel=nutrition').catch(() => {});
    res.json({ ok: true, nutrition_plan: restored });
  } catch(err) {
    console.error('[reset-nutrition]', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Client-facing endpoints ───────────────────────────
app.get('/api/my-coach', requireAuth, async (req, res) => {
  try {
    // Active coach
    const { data: link } = await supabase.from('coach_clients')
      .select('id, coach_id, connected_at, status')
      .eq('client_id', req.user.id).eq('status', 'active').maybeSingle();
    // Pending request (most recent)
    const { data: pending } = await supabase.from('coach_clients')
      .select('id, coach_id, created_at, status')
      .eq('client_id', req.user.id).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).maybeSingle();

    let coach = null;
    let pendingCoach = null;
    if (link?.coach_id) {
      const { data: coachProfile } = await supabase.from('profiles')
        .select('name, coach_title, coach_bio').eq('id', link.coach_id).maybeSingle();
      coach = { coach_id: link.coach_id, connected_at: link.connected_at, ...coachProfile };
    }
    if (pending?.coach_id) {
      const { data: coachProfile } = await supabase.from('profiles')
        .select('name, coach_title, coach_bio').eq('id', pending.coach_id).maybeSingle();
      pendingCoach = { connection_id: pending.id, coach_id: pending.coach_id, requested_at: pending.created_at, ...coachProfile };
    }
    res.json({ coach, pending: pendingCoach });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// Lightweight check used by the Account panel every time it opens — returns the most recent
// pending coach connection request for this user (or { pending: false }).
app.get('/api/my-pending-coach-request', requireAuth, async (req, res) => {
  try {
    const { data: row } = await supabase.from('coach_clients')
      .select('id, coach_id, created_at')
      .eq('client_id', req.user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    console.log('[my-pending] result for user', req.user.id, ':', JSON.stringify(row));
    if (!row) return res.json({ pending: false });
    const { data: coachProfile } = await supabase.from('profiles')
      .select('name, coach_title, coach_bio').eq('id', row.coach_id).maybeSingle();
    res.json({
      pending: true,
      coach: {
        id: row.coach_id,
        name: coachProfile?.name || null,
        title: coachProfile?.coach_title || null,
        bio: coachProfile?.coach_bio || null,
        connection_id: row.id,
        requested_at: row.created_at,
      }
    });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/coach-connection/:connectionId/respond', requireAuth, async (req, res) => {
  try {
    const { connectionId } = req.params;
    const { action } = req.body;
    if (!['accept','decline'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    const { data: link } = await supabase.from('coach_clients')
      .select('*').eq('id', connectionId).eq('client_id', req.user.id).eq('status', 'pending').maybeSingle();
    if (!link) return res.status(404).json({ error: 'Not found' });

    if (action === 'accept') {
      await supabase.from('coach_clients').update({
        status: 'active', connected_at: new Date().toISOString(),
        coach_seen: false,
      }).eq('id', connectionId);
      // Default review settings (enabled)
      await supabase.from('coach_ai_review_settings').upsert({
        coach_id: link.coach_id, client_id: req.user.id,
        post_workout_checkin_enabled: true,
        weekly_review_enabled: true,
        monthly_review_enabled: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'coach_id,client_id' });
      await sendPushToUser(link.coach_id, 'Client connected',
        'A client has accepted your connection request.',
        '/app.html?panel=clients').catch(() => {});
      // Auto-generate the coach's private client overview in the background (do not await)
      generateClientSummary(link.coach_id, req.user.id).catch(e =>
        console.warn('[summary] generation failed:', e.message));
    } else {
      await supabase.from('coach_clients').update({
        status: 'disconnected', disconnected_at: new Date().toISOString()
      }).eq('id', connectionId);
      await sendPushToUser(link.coach_id, 'Connection declined',
        'A client declined your connection request.',
        '/app.html?panel=clients').catch(() => {});
    }
    res.json({ ok: true, action });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/coach-connection/disconnect', requireAuth, async (req, res) => {
  try {
    const { data: link } = await supabase.from('coach_clients')
      .select('id, coach_id').eq('client_id', req.user.id).eq('status', 'active').maybeSingle();
    if (!link) return res.status(404).json({ error: 'No active coach' });
    await supabase.from('coach_clients').update({
      status: 'disconnected', disconnected_at: new Date().toISOString()
    }).eq('id', link.id);
    await sendPushToUser(link.coach_id, 'Client disconnected',
      'A client has ended your coaching connection.',
      '/app.html?panel=clients').catch(() => {});
    res.json({ ok: true });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Commission ────────────────────────────────────────
app.get('/api/coach/commissions', requireAuth, requireCoach, async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [thisMonthRes, allTimeRes, pendingRes, clientsRes] = await Promise.all([
      supabase.from('coach_commissions').select('commission_amount').eq('coach_id', req.user.id).gte('payment_date', monthStart),
      supabase.from('coach_commissions').select('commission_amount').eq('coach_id', req.user.id),
      supabase.from('coach_commissions').select('commission_amount').eq('coach_id', req.user.id).eq('payout_status', 'pending'),
      supabase.from('coach_clients').select('client_id').eq('coach_id', req.user.id).eq('status', 'active'),
    ]);

    const sum = (rows) => (rows || []).reduce((acc, r) => acc + (parseFloat(r.commission_amount) || 0), 0);

    // Active commission-generating clients
    const clientIds = (clientsRes.data || []).map(r => r.client_id).filter(Boolean);
    let clientList = [];
    if (clientIds.length) {
      const { data: profs } = await supabase.from('profiles')
        .select('id, name, subscription_tier').in('id', clientIds);
      clientList = (profs || []).map(p => ({
        id: p.id,
        name: p.name,
        tier: p.subscription_tier,
        commission_rate: req.coachProfile.coach_commission_rate,
      }));
    }

    res.json({
      this_month: sum(thisMonthRes.data),
      all_time: sum(allTimeRes.data),
      pending: sum(pendingRes.data),
      clients: clientList,
    });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Seat count ────────────────────────────────────────
app.get('/api/coach/seat-count', requireAuth, requireCoach, async (req, res) => {
  try {
    const used = await countActiveClients(req.user.id);
    const plan = req.coachProfile.coach_plan;
    const limit = COACH_PLAN_CONFIG[plan]?.seatLimit ?? 10;
    res.json({
      active: used,
      limit: limit === Infinity ? null : limit,
      plan,
    });
  } catch(err) { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// ── Cron — daily workout reminders ─────────────────────
// Call every ~5 min from Railway cron. Sends a push to users whose reminder_time
// (their LOCAL HH:MM) matches the current time in their reminder_timezone, within a
// 5-min window. Authenticated with the shared x-cron-secret.
app.post('/api/cron/reminders', async (req, res) => {
  try {
    if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorised' });
    }
    const now = new Date();
    // Active + trial users with a reminder set (is_frozen filtered in JS for correct NULL handling).
    const { data: users } = await supabase
      .from('profiles')
      .select('id, name, reminder_time, reminder_timezone, is_frozen, subscription_status')
      .not('reminder_time', 'is', null)
      .in('subscription_status', ['active', 'trial']);

    let sent = 0;
    for (const user of users || []) {
      if (user.is_frozen === true) continue;
      try {
        // Current wall-clock time in the user's own timezone (reminder_time is LOCAL).
        const tz = user.reminder_timezone || 'UTC';
        const nowLocal = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
        const [nh, nm] = nowLocal.split(':').map(Number);
        const [rh, rm] = String(user.reminder_time).split(':').map(Number);
        if (rh === nh && Math.abs(rm - nm) <= 5) {
          await sendPushToUser(
            user.id,
            'Time to train, ' + (user.name || 'champion'),
            'Your programme is ready. Open FORGE.',
            '/app.html'
          ).catch(() => {});
          sent++;
        }
      } catch (e) {
        console.error('[reminder]', e.message);
      }
    }
    res.json({ sent });
  } catch (err) {
    console.error('reminders cron error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Cron — inactive client check ──────────────────────
// Call from Railway cron daily; sends a single push to coaches whose clients
// have been inactive for exactly 5 days. Authenticated with a shared secret.
app.post('/api/coach/check-inactive-clients', async (req, res) => {
  try {
    const secret = req.headers['x-cron-secret'];
    if (!secret || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorised' });

    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

    const { data: links } = await supabase.from('coach_clients')
      .select('coach_id, client_id').eq('status', 'active');
    let notified = 0;
    for (const link of (links || [])) {
      if (!link.client_id) continue;
      const { data: lastLog } = await supabase.from('workout_logs')
        .select('created_at').eq('user_id', link.client_id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!lastLog?.created_at) continue;
      const ts = new Date(lastLog.created_at).getTime();
      if (ts < fiveDaysAgo.getTime() && ts >= fiveDaysAgo.getTime() - 24 * 60 * 60 * 1000) {
        // Last session was between 5 and 6 days ago — single notification
        const { data: clientProfile } = await supabase.from('profiles').select('name').eq('id', link.client_id).maybeSingle();
        await sendPushToUser(link.coach_id, 'Client inactive',
          `${clientProfile?.name || 'A client'} hasn't trained in 5 days.`,
          `/app.html?panel=clients`).catch(() => {});
        notified++;
      }
    }
    res.json({ ok: true, notified });
  } catch(err) {
    console.error('check-inactive-clients error:', err.message);
    console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' });
  }
});
