require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CLIENTS ────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── MIDDLEWARE ─────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Rate limiting — protect against abuse
const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
app.use('/api/', limiter);
app.use('/api/chat', chatLimiter);

// ── AUTH MIDDLEWARE ────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorised' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user; // user.email is available here directly
  next();
}

function requireAdmin(req, res, next) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return res.status(500).json({ error: 'ADMIN_EMAIL not configured' });
  if (req.user?.email !== adminEmail) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── HEALTH CHECK ───────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'FORGE' }));

// ── SIGNUP — Check email + create account ──────
app.post('/api/signup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    // Check if email already exists
    const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers();
    if (listErr) throw listErr;

    const exists = users.some(u => u.email?.toLowerCase() === email.toLowerCase());
    if (exists) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
    }

    // Create the account via admin (auto-confirms email)
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name }
    });
    if (error) throw error;

    // Sign them in to get a session token
    const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;

    // Save name to profile
    await supabase.from('profiles').update({ name }).eq('id', data.user.id);

    res.json({
      access_token: signInData.session.access_token,
      refresh_token: signInData.session.refresh_token,
      user: { ...signInData.user, email }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GENERATE PLAN ──────────────────────────────
// Called after onboarding — AI generates a personalised workout + nutrition plan
app.post('/api/generate-plan', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const prompt = buildPlanPrompt(profile);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content[0].text;
    console.log('Raw plan response (first 500 chars):', raw.substring(0, 500));
    
    // Strip markdown fences and find the JSON object
    let clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    // Find the outermost { } in case there's extra text
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      clean = clean.substring(start, end + 1);
    }
    
    let plan;
    try {
      plan = JSON.parse(clean);
    } catch(parseErr) {
      console.error('JSON parse error:', parseErr.message);
      console.error('Attempted to parse:', clean.substring(0, 500));
      throw new Error('Failed to parse plan JSON: ' + parseErr.message);
    }

    // Save to DB
    const { data, error } = await supabase
      .from('plans')
      .insert({ user_id: req.user.id, workout_plan: plan.workout, nutrition_plan: plan.nutrition })
      .select()
      .single();

    if (error) throw error;

    // Mark onboarding complete
    await supabase.from('profiles').update({ onboarding_complete: true }).eq('id', req.user.id);

    res.json({ plan: data });
  } catch (err) {
    console.error('Generate plan error:', err);
    res.status(500).json({ error: 'Failed to generate plan', detail: err.message });
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
      .single();

    if (error) return res.status(404).json({ error: 'No plan found' });
    res.json({ plan: data });
  } catch (err) {
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
      .single();

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
      .single();

    if (error) {
      // If error is about missing column (preferred_days not migrated yet), retry without it
      if (error.message?.includes('preferred_days')) {
        delete update.preferred_days;
        const { data: data2, error: err2 } = await supabase
          .from('profiles').update(update).eq('id', req.user.id).select().single();
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
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { messages, context } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'No messages' });

    const [{ data: profile }, { data: planData }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', req.user.id).single(),
      supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).single()
    ]);

    const { data: recentHistory } = await supabase
      .from('exercise_history')
      .select('*')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: false })
      .limit(20);

    const systemPrompt = buildCoachPrompt(profile, planData, recentHistory, context);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt,
      messages
    });

    const rawReply = response.content[0].text;

    // Check if the reply contains a plan update command
    // Coach wraps plan changes in <PLAN_UPDATE>...</PLAN_UPDATE> tags
    const planUpdateMatch = rawReply.match(/<PLAN_UPDATE>([\s\S]*?)<\/PLAN_UPDATE>/);
    let planUpdate = null;
    let cleanReply = rawReply.replace(/<PLAN_UPDATE>[\s\S]*?<\/PLAN_UPDATE>/g, '').trim();

    if (planUpdateMatch && planData) {
      try {
        const updateInstruction = JSON.parse(planUpdateMatch[1].trim());
        const currentPlan = {
          workout: planData.workout_plan,
          nutrition: planData.nutrition_plan
        };
        const updatedPlan = applyPlanUpdate(currentPlan, updateInstruction);

        // Save updated plan
        await supabase.from('plans')
          .update({
            workout_plan: updatedPlan.workout,
            nutrition_plan: updatedPlan.nutrition,
            generated_at: new Date().toISOString()
          })
          .eq('id', planData.id);

        planUpdate = {
          type: updateInstruction.type,
          summary: updateInstruction.summary
        };
      } catch(e) {
        console.error('Plan update parse error:', e.message);
      }
    }

    res.json({ reply: cleanReply, plan_update: planUpdate });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
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
    // { type: 'update_nutrition', changes: { calories: 3100, protein_g: 200 } }
    Object.assign(updated.nutrition, instruction.changes);
  }

  if (instruction.type === 'update_meal') {
    // { type: 'update_meal', meal_index: 0, changes: { foods: [...] } }
    if (updated.nutrition?.meals?.[instruction.meal_index]) {
      Object.assign(updated.nutrition.meals[instruction.meal_index], instruction.changes);
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
          day.day_index = parseInt(idx);
          day.day_name = dayNames[parseInt(idx)] || day.day_name;
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
    const { session_summary, feeling, difficulty, messages } = req.body;
    // feeling: 'great' | 'ok' | 'tired'
    // difficulty: 'too_easy' | 'just_right' | 'too_hard'

    const [{ data: profile }, { data: planData }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', req.user.id).single(),
      supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).single()
    ]);

    const { data: recentHistory } = await supabase
      .from('exercise_history').select('*').eq('user_id', req.user.id)
      .order('logged_at', { ascending: false }).limit(10);

    const systemPrompt = buildCheckinPrompt(profile, planData, recentHistory, session_summary, feeling, difficulty);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemPrompt,
      messages: messages || [{ role: 'user', content: `I just finished training. Feeling: ${feeling}. Difficulty: ${difficulty}.` }]
    });

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

    res.json({ reply: cleanReply, plan_update: planUpdate });
  } catch (err) {
    console.error('Checkin error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── LOG SESSION ────────────────────────────────
app.post('/api/log', requireAuth, async (req, res) => {
  try {
    const { day_index, day_label, exercises } = req.body;
    const today = new Date().toISOString().split('T')[0];

    // Save session log — delete today's existing log first then insert fresh
    await supabase.from('session_logs')
      .delete()
      .eq('user_id', req.user.id)
      .eq('day_index', day_index)
      .eq('logged_at', today);

    const { error: logError } = await supabase.from('session_logs').insert({
      user_id: req.user.id,
      day_index,
      day_label,
      logged_at: today,
      exercises
    });

    if (logError) throw logError;

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
        .single();

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
function buildPlanPrompt(profile) {
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
- Injuries or limitations: ${safe(profile.injuries, 'none')}

CRITICAL INSTRUCTIONS:
1. Respond ONLY with a single valid JSON object. No text before or after it.
2. Do NOT use special characters like dashes (use to instead), smart quotes, or em dashes inside string values.
3. Every string value must use only standard ASCII characters.
4. The JSON must be complete and valid - do not truncate it.

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
          { "name": "Whole eggs", "amount": "4 eggs" }
        ]
      }
    ]
  }
}`;
}

function buildCoachPrompt(profile, planData, recentHistory, context) {
  const plan = planData?.workout_plan;
  const nutrition = planData?.nutrition_plan;

  const historyStr = recentHistory?.length
    ? recentHistory.map(h => `${h.exercise_name}: ${h.sets}×${h.reps} @ ${h.weight_kg}kg (${h.logged_at})`).join('\n')
    : 'No sessions logged yet.';

  const fullPlanStr = plan?.days
    ? plan.days.map(d => `[day_index:${d.day_index}] ${d.day_name} — ${d.label}: ${d.exercises?.map(e => `${e.name} ${e.sets}x${e.reps}`).join(', ') || 'Rest'}`).join('\n')
    : 'Not generated';

  const contextStr = context ? `\nCURRENT CONTEXT: ${context}` : '';

  return `You are a world-class personal trainer and nutrition coach embedded in the FORGE fitness app. You are coaching a specific client. Be direct, specific, and actionable. No fluff. Use their exact numbers when relevant.${contextStr}

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

FULL MEAL PLAN:
${nutrition?.meals ? nutrition.meals.map((m, i) => `  meal_index:${i} = ${m.name} (${m.time}) — ${(m.foods || []).map(f => `${f.name} ${f.amount}`).join(', ')}`).join('\n') : 'Not generated'}

PLAN UPDATE TYPES — use exactly as shown:

1. MOVE A WORKOUT TO A DIFFERENT DAY:
Always check the schedule above first. Use the actual day_index values shown above.
<PLAN_UPDATE>{"type":"reschedule_days","mapping":[{"from_day_index":0,"to_day_index":4}],"summary":"Moved Monday workout to Friday"}</PLAN_UPDATE>

2. SWAP AN EXERCISE:
<PLAN_UPDATE>{"type":"swap_exercise","day_index":0,"old_exercise":"Bench Press","new_exercise":{"name":"Dumbbell Press","note":"Full ROM","sets":"4","reps":"8-10","rest":"2 min","rpe":8},"summary":"Swapped Bench Press for Dumbbell Press on Monday"}</PLAN_UPDATE>

3. CHANGE EXERCISE SETS/REPS:
<PLAN_UPDATE>{"type":"update_exercise","day_index":0,"exercise_name":"Bench Press","changes":{"sets":"5","reps":"3-5"},"summary":"Updated Bench Press to 5x3-5"}</PLAN_UPDATE>

4. CHANGE NUTRITION MACROS:
<PLAN_UPDATE>{"type":"update_nutrition","changes":{"calories":3100,"protein_g":200,"carbs_g":360,"fat_g":90},"summary":"Updated macros to 3100 kcal"}</PLAN_UPDATE>

5. CHANGE A MEAL'S FOODS:
<PLAN_UPDATE>{"type":"update_meal","meal_index":0,"changes":{"name":"Meal 1 Breakfast","time":"7:00-8:00 AM","kcal":700,"protein_g":50,"carbs_g":70,"fat_g":20,"foods":[{"name":"Greek yogurt","amount":"200g"},{"name":"Oats","amount":"80g"},{"name":"Banana","amount":"1 large"}]},"summary":"Updated breakfast to Greek yogurt, oats and banana"}</PLAN_UPDATE>

6. REPLACE ALL EXERCISES ON A DAY:
<PLAN_UPDATE>{"type":"update_day","day_index":0,"exercises":[{"name":"Exercise","note":"cue","sets":"4","reps":"8-10","rest":"2 min","rpe":8}],"summary":"Replaced Monday workout"}</PLAN_UPDATE>

RULES:
- ALWAYS use the OCCUPIED and FREE day_index lists above — never guess
- NEVER move a workout to an OCCUPIED day_index unless the user specifically asks to swap two days
- If the user asks to move to an occupied day, tell them what's already there and ask if they want to swap
- If the user asks to move to a FREE day, just do it with reschedule_days
- NEVER say you don't have access to something — you have full access to change workouts, meals, macros, and schedules
- Always confirm what you changed in plain text after the tag`;
}

function buildCheckinPrompt(profile, planData, recentHistory, sessionSummary, feeling, difficulty) {
  const plan = planData?.workout_plan;
  const nutrition = planData?.nutrition_plan;

  const historyStr = recentHistory?.length
    ? recentHistory.map(h => `${h.exercise_name}: ${h.sets}×${h.reps} @ ${h.weight_kg}kg (${h.logged_at})`).join('\n')
    : 'No sessions logged yet.';

  const fullPlanStr = plan?.days
    ? plan.days.map(d => `${d.day_name} (${d.label}): ${d.exercises?.map(e => `${e.name} ${e.sets}×${e.reps}`).join(', ')}`).join('\n')
    : 'Not generated';

  return `You are a world-class personal trainer doing a post-workout check-in with your client. Be warm but direct. Acknowledge how they felt, give specific feedback on their session, and adapt their plan if needed.

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
      .single();

    if (error) throw error;
    res.json({ conversation: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── VIEW RAW PLAN DAYS (for debugging) ────────
app.get('/api/plan/days', requireAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('plans').select('workout_plan').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).single();
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
    const { data: planData } = await supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).single();
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
        .single();

      if (error) throw error;
      res.json({ conversation: data });
    } else {
      // Create new
      const { data, error } = await supabase
        .from('chat_conversations')
        .insert({ user_id: req.user.id, title, messages })
        .select()
        .single();

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

// ── START ──────────────────────────────────────
app.listen(PORT, () => console.log(`FORGE backend running on port ${PORT}`));

// ── DEBUG — View raw plan (admin only) ────────
app.get('/api/debug/plan', requireAuth, requireAdmin, async (req, res) => {
  const { data } = await supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).single();
  res.json(data);
});
