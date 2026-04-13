require('dotenv').config();
const express = require('express');
const https = require('https');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
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
app.use(express.json({ limit: '100kb' }));

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

    // During trial, full access regardless of tier
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
  await supabase.from('ai_coach_usage').upsert({
    user_id: userId,
    month,
    message_count: 1,
    updated_at: new Date().toISOString()
  }, {
    onConflict: 'user_id,month',
    ignoreDuplicates: false
  });
  // Increment via RPC or re-fetch and update
  const { data } = await supabase
    .from('ai_coach_usage')
    .select('id, message_count')
    .eq('user_id', userId)
    .eq('month', month)
    .maybeSingle();
  if (data) {
    await supabase.from('ai_coach_usage')
      .update({ message_count: (data.message_count || 0) + 1, updated_at: new Date().toISOString() })
      .eq('id', data.id);
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
    const prompt = buildPlanPrompt(profile, language);

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

    // Check Iron message limit (20/month)
    const { accessTier, isExempt } = req.subscription;
    if (!hasAccess('unlimited_coach', accessTier, isExempt)) {
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

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 6000,
      system: systemPrompt,
      messages: sanitised
    });

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

    // Track usage for Iron users
    if (!hasAccess('unlimited_coach', req.subscription?.accessTier, req.subscription?.isExempt)) {
      incrementCoachUsage(req.user.id).catch(() => {});
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

    // Track usage for Iron users
    if (!hasAccess('unlimited_coach', req.subscription?.accessTier, req.subscription?.isExempt)) {
      incrementCoachUsage(req.user.id).catch(() => {});
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
function buildPlanPrompt(profile, language) {
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
      trialDaysLeft = Math.max(0, Math.ceil((new Date(trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)));
    }

    const coachUsage = await getCoachUsage(req.user.id);

    res.json({
      tier,
      accessTier,
      status,
      isExempt,
      trialDaysLeft,
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
app.get('/api/monthly-review/latest', requireAuth, loadSubscription, async (req, res) => {
  try {
    const { accessTier, isExempt } = req.subscription;
    if (!hasAccess('monthly_review', accessTier, isExempt)) {
      return res.status(403).json({ error: 'feature_locked', message: 'Monthly reviews are available on the Forge plan.' });
    }

    const month = billingMonth();
    const { data } = await supabase
      .from('monthly_reviews')
      .select('*')
      .eq('user_id', req.user.id)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    res.json({ review: data || null });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RETENTION FEATURES ────────────────────────
const retentionRoutes = require('./routes/retention')(supabase, anthropic);
app.use('/api', requireAuth, retentionRoutes);

// ── START ──────────────────────────────────────
// ── EXERCISE LOOKUP — MuscleWiki API proxy ─────────────
app.get('/api/exercise/search', requireAuth, async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  const apiKey = process.env.MUSCLEWIKI_API_KEY;
  const mwSearchUrl = 'https://musclewiki.com/search?q=' + encodeURIComponent(name);

  if (!apiKey) {
    return res.json({ exercise: { name, videoUrl: null, instructions: [], primaryMuscles: [], category: '', difficulty: '', muscleWikiUrl: mwSearchUrl } });
  }

  try {
    const searchRes = await fetch(
      'https://api.musclewiki.com/search?q=' + encodeURIComponent(name) + '&limit=5',
      { headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' } }
    );

    if (!searchRes.ok) {
      console.error('MuscleWiki search failed:', searchRes.status);
      return res.json({ exercise: { name, videoUrl: null, instructions: [], primaryMuscles: [], category: '', difficulty: '', muscleWikiUrl: mwSearchUrl } });
    }

    const results = await searchRes.json();
    if (!Array.isArray(results) || !results.length) {
      return res.json({ exercise: { name, videoUrl: null, instructions: [], primaryMuscles: [], category: '', difficulty: '', muscleWikiUrl: mwSearchUrl } });
    }

    // Pick best match — exact name first, then first result
    const nameLower = name.toLowerCase();
    const best = results.find(r => r.name?.toLowerCase() === nameLower) || results[0];

    // Get both male front and side video filenames
    const videos = best.videos || [];
    const maleFront = videos.find(v => v.gender === 'male' && v.angle === 'front');
    const maleSide  = videos.find(v => v.gender === 'male' && v.angle === 'side');
    const fallback  = videos[0];

    const getFilename = v => v?.url ? v.url.split('/branded/')[1] : null;
    const frontFilename = getFilename(maleFront) || getFilename(fallback);
    const sideFilename  = getFilename(maleSide);

    // Build slug for musclewiki.com page URL
    const slug = best.name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '-');

    res.json({
      exercise: {
        name: best.name,
        videoFilename: frontFilename || null,
        videoFilename2: sideFilename || null,
        instructions: best.steps || [],
        primaryMuscles: best.primary_muscles || [],
        secondaryMuscles: [],
        category: best.category || '',
        difficulty: best.difficulty || '',
        muscleWikiUrl: 'https://musclewiki.com/exercise/' + slug,
      }
    });

  } catch(err) {
    console.error('MuscleWiki API error:', err.message);
    res.json({ exercise: { name, videoUrl: null, instructions: [], primaryMuscles: [], category: '', difficulty: '', muscleWikiUrl: mwSearchUrl } });
  }
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

app.listen(PORT, () => console.log(`FORGE backend running on port ${PORT}`));

// ── DEBUG — View raw plan (admin only) ────────
app.get('/api/debug/plan', requireAuth, requireAdmin, async (req, res) => {
  const { data } = await supabase.from('plans').select('*').eq('user_id', req.user.id).order('generated_at', { ascending: false }).limit(1).maybeSingle();
  res.json(data);
});
