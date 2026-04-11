/**
 * FORGE — Weekly AI Review Cron Job
 * Schedule: Every Sunday at 9am UTC → "0 9 * * 0"
 * Run on Railway as a separate service or via cron trigger
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateWeeklyReviews() {
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  const weekStartStr = weekStart.toISOString().split('T')[0];

  // Get all active users (logged at least once this week)
  const { data: activeSessions } = await supabase
    .from('session_logs')
    .select('user_id')
    .gte('logged_at', weekStartStr);

  const userIds = [...new Set((activeSessions || []).map(s => s.user_id))];
  console.log(`Processing ${userIds.length} active users`);

  for (const userId of userIds) {
    try {
      // Get week's sessions
      const { data: sessions } = await supabase
        .from('session_logs')
        .select('*')
        .eq('user_id', userId)
        .gte('logged_at', weekStartStr);

      // Get PRs this week
      const { data: prs } = await supabase
        .from('personal_records')
        .select('*')
        .eq('user_id', userId)
        .gte('achieved_at', weekStartStr);

      // Get user profile + plan
      const { data: profile } = await supabase
        .from('profiles')
        .select('goal, experience, name')
        .eq('id', userId)
        .maybeSingle();
      if (!profile) { console.log(`No profile for ${userId}, skipping`); continue; }

      const { data: plan } = await supabase
        .from('plans')
        .select('workout_plan')
        .eq('user_id', userId)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // Get streak
      const { data: streak } = await supabase
        .from('streaks')
        .select('current_streak')
        .eq('user_id', userId)
        .maybeSingle();

      const totalVolume = (sessions || []).reduce((sum, s) => {
        const exVol = (s.exercises || []).reduce((v, e) => v + (e.vol || 0), 0);
        return sum + exVol;
      }, 0);

      const plannedDays = plan ? Object.keys(plan.workout_plan || {}).length : 0;

      // Generate AI summary
      const aiResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `You are FORGE, an AI fitness coach. Write a weekly review for ${profile?.name || 'this user'}.
Goal: ${profile?.goal || 'general fitness'}
Experience: ${profile?.experience || 'unknown'}
Workouts completed: ${sessions?.length || 0}/${plannedDays} planned
Total volume: ${Math.round(totalVolume)}kg
PRs this week: ${prs?.length || 0}${prs?.length ? ' — ' + prs.map(p => p.exercise_name).join(', ') : ''}
Current streak: ${streak?.current_streak || 0} days

Write:
1. One-line summary (how the week went)
2. Top highlight
3. One thing to improve next week
4. Motivational closer (1 line, no cheese)

Under 120 words. Direct. No fluff.`
        }]
      });

      const summary = aiResponse.content[0].text;

      // Save review
      await supabase
        .from('weekly_reviews')
        .insert({
          user_id: userId,
          week_start: weekStartStr,
          summary,
          workouts_completed: sessions?.length || 0,
          workouts_planned: plannedDays,
          total_volume: totalVolume,
          prs_hit: prs?.length || 0,
          ai_insights: summary
        });

      console.log(`Review generated for ${userId}`);
    } catch (err) {
      console.error(`Error for user ${userId}:`, err.message);
    }
  }

  console.log('Weekly reviews complete');
}

// ── PUSH NOTIFICATION SENDER ──────────────────
async function sendPushReminders() {
  // Get users who haven't worked out today
  const today = new Date().toISOString().split('T')[0];

  const { data: allSubs } = await supabase
    .from('push_subscriptions')
    .select('user_id, subscription');

  if (!allSubs?.length) return;

  const { data: todaySessions } = await supabase
    .from('session_logs')
    .select('user_id')
    .eq('logged_at', today);

  const loggedToday = new Set((todaySessions || []).map(s => s.user_id));

  // Only notify users who haven't logged today
  const toNotify = allSubs.filter(s => !loggedToday.has(s.user_id));

  // Web Push requires the web-push library
  let webpush;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(
      'mailto:' + (process.env.VAPID_EMAIL || 'hello@forge.app'),
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } catch (e) {
    console.log('web-push not installed, skipping push notifications');
    return;
  }

  for (const sub of toNotify) {
    try {
      // Get streak for personalised message
      const { data: streak } = await supabase
        .from('streaks')
        .select('current_streak')
        .eq('user_id', sub.user_id)
        .maybeSingle();

      const streakCount = streak?.current_streak || 0;
      let message = "Time to train. Your future self will thank you.";
      if (streakCount >= 7) message = `${streakCount}-day streak. Don't break it now.`;
      else if (streakCount >= 3) message = `${streakCount} days strong. Keep building.`;

      await webpush.sendNotification(
        sub.subscription,
        JSON.stringify({
          title: 'FORGE',
          body: message,
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-72.png'
        })
      );
    } catch (err) {
      if (err.statusCode === 410) {
        // Subscription expired, clean up
        await supabase
          .from('push_subscriptions')
          .delete()
          .eq('id', sub.id);
      }
    }
  }
}

// ── ENTRY POINT ───────────────────────────────
const job = process.argv[2] || 'review';

if (job === 'review') {
  generateWeeklyReviews().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else if (job === 'push') {
  sendPushReminders().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
