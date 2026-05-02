/**
 * FORGE — Monthly AI Deep-Dive Review Cron
 * Schedule: 1st of every month at 9am UTC → "0 9 1 * *"
 * Run: node monthly-review.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;

// Validate required env vars before attempting to connect
const REQUIRED_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length) {
  console.error('Missing required environment variables:', missing.join(', '));
  console.error('Make sure these are set in Railway environment variables.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
console.log('Monthly review job starting — Supabase and Anthropic clients initialised ✓');

function billingMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function generateMonthlyReviews() {
  const month = billingMonth();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartStr = monthStart.toISOString().split('T')[0];

  console.log(`Generating monthly reviews for ${month}`);

  // Get all active Forge users (not expired, is_exempt or subscription_tier = forge)
  const { data: forgeProfiles } = await supabase
    .from('profiles')
    .select('id, name, goal, experience')
    .or('is_exempt.eq.true,subscription_tier.eq.forge')
    .not('subscription_status', 'eq', 'expired');

  if (!forgeProfiles?.length) {
    console.log('No Forge users found');
    return;
  }

  console.log(`Processing ${forgeProfiles.length} Forge users`);

  for (const profile of forgeProfiles) {
    try {
      // Skip if review already generated this month
      const { data: existing } = await supabase
        .from('monthly_reviews')
        .select('id')
        .eq('user_id', profile.id)
        .eq('month', month)
        .maybeSingle();
      if (existing) { console.log(`Already reviewed: ${profile.id}`); continue; }

      // Gather all data for the month
      const [
        { data: sessions },
        { data: prs },
        { data: bodyMetrics },
        { data: plan },
        { data: streak }
      ] = await Promise.all([
        supabase.from('session_logs').select('*').eq('user_id', profile.id).gte('logged_at', monthStartStr),
        supabase.from('personal_records').select('*').eq('user_id', profile.id).gte('achieved_at', monthStartStr),
        supabase.from('body_metrics').select('*').eq('user_id', profile.id).order('logged_at', { ascending: false }).limit(2),
        supabase.from('plans').select('workout_plan').eq('user_id', profile.id).order('generated_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('streaks').select('current_streak, longest_streak').eq('user_id', profile.id).maybeSingle()
      ]);

      const totalVolume = (sessions || []).reduce((sum, s) =>
        sum + (s.exercises || []).reduce((v, e) =>
          v + (e.sets_data || []).reduce((sv, set) => sv + (set.weight || 0) * (set.reps || 0), 0), 0), 0);

      const plannedDays = plan?.workout_plan?.days?.length || 0;
      const metrics = bodyMetrics?.[0];
      const prevMetrics = bodyMetrics?.[1];

      const aiResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `You are FORGE, a world-class AI fitness coach. Write a monthly deep-dive review for ${profile.name || 'this user'}.

MONTH: ${month}
GOAL: ${profile.goal || 'general fitness'}
EXPERIENCE: ${profile.experience || 'unknown'}
WORKOUTS COMPLETED: ${sessions?.length || 0} / ${plannedDays} planned sessions
TOTAL VOLUME LIFTED: ${Math.round(totalVolume)}kg
PERSONAL RECORDS: ${prs?.length || 0}${prs?.length ? ' — ' + prs.slice(0, 5).map(p => p.exercise_name).join(', ') : ''}
CURRENT STREAK: ${streak?.current_streak || 0} days
LONGEST STREAK: ${streak?.longest_streak || 0} days
BODY METRICS THIS MONTH: ${metrics ? `Chest: ${metrics.chest_cm}cm, Waist: ${metrics.waist_cm}cm, Weight change: ${prevMetrics ? ((metrics.weight_kg || 0) - (prevMetrics.weight_kg || 0)).toFixed(1) + 'kg' : 'no previous data'}` : 'Not logged'}

Write a structured monthly review with these sections:
1. **Month in Review** — 2-3 sentences on how the month went overall
2. **Top Highlight** — The single best achievement this month
3. **Key Strength** — What they consistently did well
4. **Area to Improve** — One honest, specific improvement area
5. **Recommended Focus** — Specific action plan for next 30 days
6. **Coaching Note** — One motivational line, earned not generic

Under 200 words total. Direct. No fluff. Write like a coach who actually knows their client.`
        }]
      });

      const reviewContent = aiResponse.content[0].text;

      await supabase.from('monthly_reviews').upsert({
        user_id: profile.id,
        month,
        review_content: reviewContent,
        workouts_completed: sessions?.length || 0,
        workouts_planned: plannedDays,
        total_volume: Math.round(totalVolume),
        prs_hit: prs?.length || 0,
        generated_at: new Date().toISOString()
      }, { onConflict: 'user_id,month' });

      console.log(`Monthly review generated for ${profile.id}`);
    } catch(err) {
      console.error(`Error for user ${profile.id}:`, err.message);
    }
  }

  console.log('Monthly reviews complete');
}

generateMonthlyReviews()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
