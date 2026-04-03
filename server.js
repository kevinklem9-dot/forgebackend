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
      max_tokens: 4000,
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
    const { data, error } = await supabase
      .from('profiles')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ profile: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI CHAT ────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'No messages' });

    // Fetch user profile + latest plan for context
    const [{ data: profile }, { data: planData }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', req.user.id).single(),
      supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).single()
    ]);

    // Fetch recent exercise history for context
    const { data: recentHistory } = await supabase
      .from('exercise_history')
      .select('*')
      .eq('user_id', req.user.id)
      .order('logged_at', { ascending: false })
      .limit(20);

    const systemPrompt = buildCoachPrompt(profile, planData, recentHistory);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── LOG SESSION ────────────────────────────────
app.post('/api/log', requireAuth, async (req, res) => {
  try {
    const { day_index, day_label, exercises } = req.body;
    const today = new Date().toISOString().split('T')[0];

    // Upsert session log
    const { error: logError } = await supabase
      .from('session_logs')
      .upsert({
        user_id: req.user.id,
        day_index,
        day_label,
        logged_at: today,
        exercises
      }, { onConflict: 'user_id,day_index,logged_at' });

    if (logError) throw logError;

    // Upsert exercise history + PRs
    const prUpdates = [];
    for (const ex of exercises) {
      const vol = ex.weight * ex.reps * ex.sets;
      const est1rm = Math.round(ex.weight * (1 + ex.reps / 30));

      await supabase.from('exercise_history').upsert({
        user_id: req.user.id,
        exercise_name: ex.name,
        logged_at: today,
        weight_kg: ex.weight,
        reps: ex.reps,
        sets: ex.sets,
        volume: vol,
        est_1rm: est1rm
      }, { onConflict: 'user_id,exercise_name,logged_at' });

      // Check & update PR
      const { data: existingPR } = await supabase
        .from('personal_records')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('exercise_name', ex.name)
        .single();

      if (!existingPR || est1rm > existingPR.est_1rm) {
        await supabase.from('personal_records').upsert({
          user_id: req.user.id,
          exercise_name: ex.name,
          weight_kg: ex.weight,
          reps: ex.reps,
          sets: ex.sets,
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
  return `You are an expert strength and conditioning coach. Generate a completely personalised workout and nutrition plan for this person.

PROFILE:
- Name: ${profile.name || 'User'}
- Age: ${profile.age}, Sex: ${profile.sex}
- Height: ${profile.height_cm}cm, Weight: ${profile.weight_kg}kg
- Goal: ${profile.goal}
- Experience: ${profile.experience}
- Training days per week: ${profile.days_per_week}
- Equipment: ${profile.equipment}
- Diet style: ${profile.diet_style}
- Diet restrictions: ${profile.diet_restrictions || 'None'}
- Injuries/limitations: ${profile.injuries || 'None'}
- Target weight: ${profile.target_weight_kg || 'Not specified'}kg

Generate a plan that is completely tailored to this person. Consider their experience level, goal, available days, and equipment.

Respond ONLY with valid JSON in exactly this structure (no markdown, no explanation):
{
  "workout": {
    "split_name": "e.g. PPL x2, Upper/Lower, Full Body",
    "split_description": "brief description of the split logic",
    "days": [
      {
        "day_index": 0,
        "day_name": "Monday",
        "label": "Push A",
        "muscles": ["Chest", "Shoulders", "Triceps"],
        "exercises": [
          {
            "name": "Barbell Bench Press",
            "note": "coaching cue",
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
    "strategy": "brief explanation of the approach",
    "meals": [
      {
        "name": "Meal 1 — Breakfast",
        "time": "7:00–8:00 AM",
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

function buildCoachPrompt(profile, planData, recentHistory) {
  const plan = planData?.workout_plan;
  const nutrition = planData?.nutrition_plan;

  const historyStr = recentHistory?.length
    ? recentHistory.map(h => `${h.exercise_name}: ${h.sets}×${h.reps} @ ${h.weight_kg}kg (${h.logged_at})`).join('\n')
    : 'No sessions logged yet.';

  return `You are a world-class personal trainer and nutrition coach embedded in the FORGE fitness app. You are coaching a specific client. Be direct, specific, and actionable. No fluff. Use their exact numbers when relevant.

CLIENT PROFILE:
- Name: ${profile?.name || 'User'}
- Age: ${profile?.age}, Sex: ${profile?.sex}
- Height: ${profile?.height_cm}cm, Weight: ${profile?.weight_kg}kg
- Goal: ${profile?.goal}
- Experience: ${profile?.experience}
- Training: ${profile?.days_per_week} days/week, ${profile?.equipment}
- Diet: ${profile?.diet_style} — restrictions: ${profile?.diet_restrictions || 'none'}
- Injuries: ${profile?.injuries || 'none'}

THEIR PROGRAMME:
Split: ${plan?.split_name || 'Not yet generated'}
${plan?.days ? plan.days.map(d => `${d.day_name}: ${d.label} (${d.muscles?.join(', ')})`).join('\n') : ''}

NUTRITION TARGETS:
${nutrition ? `${nutrition.calories} kcal — ${nutrition.protein_g}g protein, ${nutrition.carbs_g}g carbs, ${nutrition.fat_g}g fat` : 'Not yet generated'}

RECENT TRAINING HISTORY:
${historyStr}

YOUR ROLE: Be their coach. Give specific, personalised advice based on their exact profile and history. Reference their actual numbers. Sound like someone who's fully invested in this person's progress.`;
}

// ── ADMIN — Get all users ──────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const { data: { users: authUsers }, error: authErr } = await supabase.auth.admin.listUsers();
    if (authErr) throw authErr;

    const emailMap = {};
    authUsers.forEach(u => emailMap[u.id] = u.email);

    const users = profiles.map(p => ({ ...p, email: emailMap[p.id] || '—' }));
    res.json({ users });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN — Delete user ────────────────────────────────
app.delete('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.auth.admin.deleteUser(req.params.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── START ──────────────────────────────────────
app.listen(PORT, () => console.log(`FORGE backend running on port ${PORT}`));
