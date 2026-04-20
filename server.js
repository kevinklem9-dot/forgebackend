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
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── MIDDLEWARE ─────────────────────────────────
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.FRONTEND_URL,
      'https://kevinklem9-dot.github.io',
      'http://localhost:3000',
      'http://localhost:5173'
    ].filter(Boolean);
    if (allowed.some(o => origin.startsWith(o))) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
};
app.use(helmet({ contentSecurityPolicy: false })); // Security headers
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle all preflight requests
app.use(express.json({ limit: '500kb' }));

// Rate limiting — protect against abuse
const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const planLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Too many plan generations — try again in an hour.' } });
const checkinLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: { error: 'Too many check-ins — slow down.' } });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many signups — try again later.' } });
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Too many reset attempts — try again later.' } });
app.use('/api/', limiter);
app.use('/api/chat', chatLimiter);
app.use('/api/generate-plan', planLimiter);
app.use('/api/checkin', checkinLimiter);

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
  if (req.user?.email !== adminEmail) return res.status(403).json({ error: 'Forbidden' });
  next();
}


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
    // Use admin client here since the user isn't authenticated yet
    if (data.user?.id) {
      const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await supabase.from('profiles').update({
        name,
        subscription_tier: 'iron',
        subscription_status: 'trial',
        trial_ends_at: trialEndsAt
      }).eq('id', data.user.id);
    }

    // Return success — user must confirm email before logging in
    res.json({ requires_confirmation: true, email });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── GENERATE PLAN ──────────────────────────────
app.post('/api/generate-plan', requireAuth, async (req, res) => {
  try {
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .maybeSingle();

    if (profileErr || !profile) {
      console.error('Profile fetch error:', profileErr?.message);
      return res.status(404).json({ error: 'Profile not found. Please try again.' });
    }

    console.log('Generating plan for:', profile.name, '| goal:', profile.goal, '| injuries:', profile.injuries);

    const language = req.body?.language || 'en';

    // Fetch MuscleWiki exercise list to inject into prompt
    const mwExercises = await getMuscleWikiExercises();
    const prompt = buildPlanPrompt(profile, language, mwExercises);

    // Try up to 2 times in case of JSON parse failure
    let plan = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const message = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 12000,
          messages: [{ role: 'user', content: prompt }]
        });

        const raw = message.content[0].text;
        console.log(`Attempt ${attempt} - raw response length:`, raw.length);

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
      return res.status(500).json({ error: 'Failed to generate plan — please try again', detail: lastError?.message });
    }

    // Delete any existing plan for this user first (clean slate)
    await supabase.from('plans').delete().eq('user_id', req.user.id);

    // Save to DB
    const { data, error } = await supabase
      .from('plans')
      .insert({ user_id: req.user.id, workout_plan: plan.workout, nutrition_plan: plan.nutrition })
      .select()
      .maybeSingle();

    if (error) {
      console.error('DB insert error:', error.message);
      throw error;
    }

    // Also save to programmes table (deactivate existing, add new active one)
    const planName = `${profile?.goal || 'My'} Plan — ${new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
    await supabase.from('programmes').update({ is_active: false }).eq('user_id', req.user.id);
    await supabase.from('programmes').insert({
      user_id: req.user.id,
      name: planName,
      plan_data: { workout: plan.workout, nutrition: plan.nutrition },
      is_active: true
    });

    // Mark onboarding complete
    await supabase.from('profiles').update({ onboarding_complete: true }).eq('id', req.user.id);

    console.log('Plan generated successfully for:', profile.name);
    res.json({ plan: data });
  } catch (err) {
    console.error('Generate plan error:', err.message);
    res.status(500).json({ error: 'Failed to generate plan — please try again', detail: err.message });
  }
});

// ── TRANSLATE PLAN ─────────────────────────────
app.post('/api/translate-plan', requireAuth, async (req, res) => {
  try {
    const { language } = req.body;
    if (!language || language === 'en') return res.json({ ok: true, skipped: true });

    const LANG_NAMES = { es:'Spanish', fr:'French', de:'German', it:'Italian', pt:'Portuguese', nl:'Dutch', uk:'Ukrainian', fi:'Finnish', ar:'Arabic', zh:'Chinese (Simplified)', ja:'Japanese' };
    const langName = LANG_NAMES[language] || language;

    // Load the user's current plan
    const { data: planRow } = await supabase
      .from('plans')
      .select('*')
      .eq('user_id', req.user.id)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!planRow) return res.status(404).json({ error: 'No plan found' });

    const plan = planRow.workout_plan;
    const nutrition = planRow.nutrition_plan;

    // Extract only translatable text — exercise names stay in English (universal gym terminology)
    const toTranslate = {
      split_name: plan?.split_name || '',
      split_description: plan?.split_description || '',
      strategy: nutrition?.strategy || '',
      days: (plan?.days || []).map(d => ({
        day_name: d.day_name || '',
        label: d.label || '',
        muscles: d.muscles || [],
        exercise_notes: (d.exercises || []).map(e => e.note || ''),
      })),
      meal_names: (nutrition?.meals || []).map(m => m.name || ''),
      food_names: (nutrition?.meals || []).flatMap(m => (m.foods || []).map(f => f.name || '')),
    };

    const prompt = `Translate the following fitness plan text fields from English into ${langName}.
Rules:
- Keep exercise names (e.g. "Barbell Bench Press", "Squat") in English — these are universal gym terms
- Translate everything else: day names, labels, muscle names, exercise notes, meal names, food names, strategy
- Keep all numbers, units (kg, g, kcal, min), time formats exactly as-is
- Return ONLY valid JSON with the same structure, no explanation

Input JSON:
${JSON.stringify(toTranslate, null, 2)}`;

    const aiRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    let translated;
    try {
      const text = aiRes.content[0]?.text || '';
      const clean = text.replace(/```json\n?|```/g, '').trim();
      translated = JSON.parse(clean);
    } catch (e) {
      console.error('Translate plan parse error:', e.message);
      return res.status(500).json({ error: 'Failed to parse translation' });
    }

    // Apply translations back to plan objects (deep clone to avoid mutation)
    const newPlan = JSON.parse(JSON.stringify(plan));
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
        if (newPlan.days[i].exercises?.[j] && note) {
          newPlan.days[i].exercises[j].note = note;
        }
      });
    });

    // Translate meal names
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

    res.json({ ok: true, workout_plan: newPlan, nutrition_plan: newNutrition });
  } catch (err) {
    console.error('translate-plan error:', err);
    res.status(500).json({ error: err.message });
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
      .maybeSingle(); // returns null instead of throwing when no rows

    if (!data) return res.json({ plan: null });
    res.json({ plan: data });
  } catch (err) {
    console.error('Get plan error:', err.message);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE PROFILE ─────────────────────────────
app.patch('/api/profile', requireAuth, async (req, res) => {
  try {
    // Only update columns that exist in the schema — ignore unknowns
    const allowed = ['name','age','sex','height_cm','weight_kg','goal','experience',
      'days_per_week','preferred_days','equipment','diet_style','diet_restrictions',
      'injuries','target_weight_kg','onboarding_complete'];
    const update = { updated_at: new Date().toISOString() };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    const { data, error } = await supabase
      .from('profiles')
      .update(update)
      .eq('id', req.user.id)
      .select()
      .maybeSingle();

    if (error) {
      // If error is about missing column (preferred_days not migrated yet), retry without it
      if (error.message?.includes('preferred_days')) {
        delete update.preferred_days;
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
    res.status(500).json({ error: err.message });
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
      supabase.from('profiles').select('*').eq('id', req.user.id).maybeSingle(),
      supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).maybeSingle()
    ]);

    const { data: recentHistory } = await supabase
      .from('exercise_history')
      .select('*')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: false })
      .limit(20);

    const systemPrompt = buildCoachPrompt(profile, planData, recentHistory, context, language);

    // Retry up to 3 times on 529 overloaded errors
    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
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
        .from('plans').select('*').eq('user_id', req.user.id)
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
            generated_at: new Date().toISOString()
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
    res.status(500).json({ error: err.message, detail: err.stack?.split('\n')[1] });
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

  return updated;
}

// ── POST-WORKOUT CHECK-IN ──────────────────────
app.post('/api/checkin', requireAuth, async (req, res) => {
  try {
    const { session_summary, feeling, difficulty, messages, language } = req.body;

    const [{ data: profile }, { data: planData }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', req.user.id).maybeSingle(),
      supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).maybeSingle()
    ]);

    const { data: recentHistory } = await supabase
      .from('exercise_history').select('*').eq('user_id', req.user.id)
      .order('logged_at', { ascending: false }).limit(10);

    const systemPrompt = buildCheckinPrompt(profile, planData, recentHistory, session_summary, feeling, difficulty, language);

    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
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
          generated_at: new Date().toISOString()
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
    res.status(500).json({ error: err.message });
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

    const prUpdates = [];
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

      // Delete existing history entry for today then insert fresh
      await supabase.from('exercise_history')
        .delete()
        .eq('user_id', req.user.id)
        .eq('exercise_name', ex.name)
        .eq('logged_at', today);

      await supabase.from('exercise_history').insert({
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

      // Check & update PR
      const { data: existingPR } = await supabase
        .from('personal_records')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('exercise_name', ex.name)
        .maybeSingle();

      if (!existingPR || est1rm > (existingPR.est_1rm || 0)) {
        await supabase.from('personal_records').upsert({
          user_id: req.user.id,
          exercise_name: ex.name,
          weight_kg: bestSet.weight,
          reps: bestSet.reps,
          sets: setsData.length,
          est_1rm: est1rm,
          achieved_at: today
        }, { onConflict: 'user_id,exercise_name' });
        prUpdates.push(ex.name);
      }
    }

    res.json({ success: true, new_prs: prUpdates });
  } catch (err) {
    console.error('Log error:', err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── GET ALL HISTORY ────────────────────────────
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('exercise_history')
      .select('*')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: true });

    if (error) throw error;
    res.json({ history: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET PRs ────────────────────────────────────
app.get('/api/prs', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('personal_records')
      .select('*')
      .eq('user_id', req.user.id)
      .order('achieved_at', { ascending: false });

    if (error) throw error;
    res.json({ prs: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LOG BODYWEIGHT ─────────────────────────────
app.post('/api/bodyweight', requireAuth, async (req, res) => {
  try {
    const { weight_kg } = req.body;
    const today = new Date().toISOString().split('T')[0];

    await supabase.from('bodyweight_log').upsert({
      user_id: req.user.id,
      weight_kg,
      logged_at: today
    }, { onConflict: 'user_id,logged_at' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET STREAK & BADGES ────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    // Get all session logs to compute streak and monthly counts
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
    res.status(500).json({ error: err.message });
  }
});

// ── GET BODYWEIGHT HISTORY ─────────────────────
app.get('/api/bodyweight', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bodyweight_log')
      .select('*')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: true });

    if (error) throw error;
    res.json({ history: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROMPT BUILDERS ────────────────────────────
function buildPlanPrompt(profile, language, mwExercises) {
  const langNames = {en:'English',es:'Spanish',fr:'French',de:'German',it:'Italian',pt:'Portuguese',nl:'Dutch',uk:'Ukrainian',fi:'Finnish',ar:'Arabic',zh:'Chinese',ja:'Japanese'};
  const langName = (language && language !== 'en') ? (langNames[language] || 'English') : 'English';
  // Sanitise all string fields to prevent JSON issues
  const safe = (v, fallback = 'not specified') => String(v || fallback).replace(/["""'']/g, '').substring(0, 200).trim();

  return `You are an expert strength and conditioning coach. Generate a completely personalised workout and nutrition plan.

PROFILE:
- Name: ${safe(profile.name, 'User')}
- Age: ${profile.age || 18}, Sex: ${safe(profile.sex, 'male')}
- Height: ${profile.height_cm || 175}cm, Weight: ${profile.weight_kg || 70}kg
- Goal: ${safe(profile.goal, 'muscle')}
- Experience: ${safe(profile.experience, 'intermediate')}
- Training days per week: ${profile.days_per_week || 4}
- Preferred training days: ${safe(profile.preferred_days, 'flexible')}
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

function buildCoachPrompt(profile, planData, recentHistory, context, language) {
  const plan = planData?.workout_plan;
  const nutrition = planData?.nutrition_plan;

  const historyStr = recentHistory?.length
    ? recentHistory.map(h => `${h.exercise_name}: ${h.sets}×${h.reps} @ ${h.weight_kg}kg (${h.logged_at})`).join('\n')
    : 'No sessions logged yet.';

  const fullPlanStr = plan?.days
    ? plan.days.map(d => `[day_index:${d.day_index}] ${d.day_name} — ${d.label}: ${d.exercises?.map(e => `${e.name} ${e.sets}x${e.reps}`).join(', ') || 'Rest'}`).join('\n')
    : 'Not generated';

  const contextStr = context ? `\nCURRENT CONTEXT: ${context}` : '';

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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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

    await supabase.from('plans').update({ workout_plan: plan }).eq('id', planData.id);
    res.json({ success: true, days: plan.days.map(d => ({ day_index: d.day_index, day_name: d.day_name, label: d.label })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});


// ── SUBSCRIPTION — Get current status ─────────────────
app.get('/api/subscription', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { tier, accessTier, status, isExempt, trialEndsAt } = req.subscription;

    let trialDaysLeft = 0;
    if (status === 'trial' && trialEndsAt) {
      trialDaysLeft = Math.max(0, Math.floor((new Date(trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)));
    }

    const coachUsage = await getCoachUsage(req.user.id);

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
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN — Get all users ──────────────────────────────
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});


// ── ADMIN — Set user tier ──────────────────────
// ── USER TIER SELECTION (preview — Stripe not yet live) ──
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});


// ── PROGRAMMES — Multiple saved plans ─────────
app.get('/api/programmes', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('programmes')
      .select('id, name, created_at, is_active')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ programmes: data || [] });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/programmes', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { name, plan_data } = req.body;
    if (!plan_data) return res.status(400).json({ error: 'No plan data provided' });

    // Check programme limit for Iron users
    const { accessTier, isExempt } = req.subscription;
    if (!hasAccess('multiple_programmes', accessTier, isExempt)) {
      const { count } = await supabase
        .from('programmes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', req.user.id);
      if (count >= 1) {
        return res.status(403).json({
          error: 'programme_limit_reached',
          message: 'Multiple programmes unlock on Steel. Upgrade to save more than one programme.'
        });
      }
    }

    const { data, error } = await supabase
      .from('programmes')
      .insert({ user_id: req.user.id, name: name || 'My Programme', plan_data, is_active: false })
      .select()
      .maybeSingle();
    if (error) throw error;
    res.json({ programme: data });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/programmes/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_active } = req.body;

    if (is_active) {
      // Deactivate all other programmes first
      await supabase.from('programmes')
        .update({ is_active: false })
        .eq('user_id', req.user.id);
    }

    const { data, error } = await supabase
      .from('programmes')
      .update({ ...(name && { name }), ...(is_active !== undefined && { is_active }) })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    res.json({ programme: data });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/programmes/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('programmes')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
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

    const { data: sessions, error } = await supabase
      .from('session_logs')
      .select('*')
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
    res.status(500).json({ error: err.message });
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
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay()); // Sunday
    weekStart.setHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const [profileRes, sessionsRes, prsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('workout_logs').select('*').eq('user_id', userId).gte('created_at', weekStart.toISOString()),
      supabase.from('personal_records').select('*').eq('user_id', userId).gte('achieved_at', weekStartStr),
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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

    // Gather monthly data
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const monthName = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const [profileRes, sessionsRes, prsRes, metricsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('workout_logs').select('*').eq('user_id', userId).gte('created_at', monthStart).order('created_at', { ascending: false }),
      supabase.from('personal_records').select('*').eq('user_id', userId).gte('achieved_at', monthStart),
      supabase.from('body_metrics').select('*').eq('user_id', userId).gte('recorded_at', monthStart).order('recorded_at', { ascending: false }),
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
    res.status(500).json({ error: err.message });
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
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });
  });

  proxyReq.on('error', (e) => {
    console.error('proxyReq error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'timeout' });
  });

  proxyReq.end();
});


// ── EXERCISE DEBUG — see raw MuscleWiki response ───────
app.get('/api/exercise/debug', requireAuth, async (req, res) => {
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
    res.json({ error: err.message });
  }
});


// ── EXERCISE VIDEO TRACE — full debug trace for video lookup ──
// ── YOUTUBE VIDEO TEST ────────────────────────────────
app.get('/api/exercise/yt-test', requireAuth, async (req, res) => {
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
app.get('/api/exercise/mw-debug', requireAuth, async (req, res) => {
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
    res.json({ error: e.message, stack: e.stack?.split('\n').slice(0,3) });
  }
});

app.get('/api/exercise/test-video', requireAuth, async (req, res) => {
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
    trace.push({ step: 'error', message: err.message, stack: err.stack?.split('\n').slice(0, 3) });
    return res.json({ trace, error: err.message });
  }
});


// ── EXERCISE VIDEO TEST — check API key + cache status ──
app.get('/api/exercise/video-test', requireAuth, async (req, res) => {
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
    res.json({ error: e.message, status: 0 });
  }
});

// ── VIDEO BUFFER — works (confirmed 752902 bytes) ────────
app.get('/api/exercise/buftest', requireAuth, async (req, res) => {
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
    res.json({ success: false, error: e.message });
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
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`FORGE backend running on port ${PORT}`));

// ── DEBUG — View raw plan (admin only) ────────
app.get('/api/debug/plan', requireAuth, requireAdmin, async (req, res) => {
  const { data } = await supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).maybeSingle();
  res.json(data);
});

// ── EXERCISE ID FINDER — dev tool ─────────────────────
app.get('/api/exercise/find-ids', requireAuth, async (req, res) => {
  const exercises = await getMuscleWikiExercises();
  if (!exercises) return res.json({ error: 'Cache not loaded' });
  const names = (req.query.names || '').split(',').map(n => n.trim().toLowerCase());
  const results = names.map(n => {
    const matches = exercises.filter(e => e.name.toLowerCase().includes(n)).slice(0, 3);
    return { query: n, matches: matches.map(e => ({ id: e.id, name: e.name, videos: (e.videos||[]).length })) };
  });
  res.json({ results, totalCached: exercises.length });
});
