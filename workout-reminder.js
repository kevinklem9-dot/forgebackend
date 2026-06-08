/**
 * FORGE — Daily Workout Reminder Cron Job
 * Schedule: Every 15 minutes → "0,15,30,45 * * * *"
 * Run on Railway as a separate service or via cron trigger.
 *
 * Sends a push to users whose reminder_time (their LOCAL HH:MM, stored with an
 * IANA reminder_timezone) falls inside the current 15-minute cron window.
 * Mirrors the live POST /api/cron/reminders logic, but sends via the web-push
 * library (VAPID-signed + encrypted) like cron/weekly-review.js.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Cron cadence in minutes. Fire once when local time enters [reminder, reminder + WINDOW_MIN).
// Keep this equal to the Railway cron interval so each reminder fires exactly once per day.
const WINDOW_MIN = 15;

async function sendWorkoutReminders() {
  // ── Web Push setup (VAPID) ─────────────────────────────
  let webpush;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(
      'mailto:' + (process.env.VAPID_EMAIL || 'hello@forge.app'),
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } catch (e) {
    console.log('web-push not installed, skipping workout reminders');
    return;
  }

  const now = new Date();

  // Active + trial users with a reminder set (is_frozen filtered in JS for correct NULL handling).
  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, name, reminder_time, reminder_timezone, is_frozen, subscription_status')
    .not('reminder_time', 'is', null)
    .in('subscription_status', ['active', 'trial']);

  if (error) { console.error('profiles query error:', error.message); return; }

  let matched = 0, sent = 0, errors = 0;

  for (const user of users || []) {
    if (user.is_frozen === true) continue;
    try {
      // Current wall-clock time in the user's own timezone (reminder_time is LOCAL).
      const tz = user.reminder_timezone || 'UTC';
      const nowLocal = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
      const [nh, nm] = nowLocal.split(':').map(Number);
      const [rh, rm] = String(user.reminder_time).split(':').map(Number);

      // Minutes-since-midnight, forward circular window. % 24 guards the en-GB "24:00" midnight case.
      const nowMin = (nh % 24) * 60 + nm;
      const remMin = (rh % 24) * 60 + rm;
      let diff = nowMin - remMin;
      if (diff < 0) diff += 1440;
      if (diff >= WINDOW_MIN) continue; // not in this cron's window
      matched++;

      // This user's push subscriptions (one row per user via upsert onConflict user_id).
      const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('id, subscription')
        .eq('user_id', user.id);
      if (!subs?.length) continue;

      const payload = JSON.stringify({
        title: 'Time to train, ' + (user.name || 'champion'),
        body: 'Your programme is ready. Open FORGE.',
        url: '/app.html',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-72.png'
      });

      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub.subscription, payload);
          sent++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired/gone — clean it up.
            await supabase.from('push_subscriptions').delete().eq('id', sub.id);
            console.log(`Removed expired subscription ${sub.id} (user ${user.id})`);
          } else {
            errors++;
            console.error(`Push failed for ${user.id}:`, err.statusCode || err.message);
          }
        }
      }
    } catch (e) {
      errors++;
      console.error('[reminder]', user.id, e.message);
    }
  }

  console.log(`Workout reminders complete — candidates: ${(users || []).length}, matched window: ${matched}, notifications sent: ${sent}, errors: ${errors}`);
}

// ── ENTRY POINT ───────────────────────────────
sendWorkoutReminders()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
