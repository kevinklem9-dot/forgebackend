/**
 * FORGE — Retention Feature Routes
 * Mounted in server.js as: app.use('/api', requireAuth, retentionRoutes)
 */

const express = require('express');

module.exports = function (supabase, anthropic) {
  const router = express.Router();

  // ── STREAK ────────────────────────────────────
  router.get('/streak', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('streaks')
        .select('*')
        .eq('user_id', req.user.id)
        .maybeSingle();

      if (!data) {
        return res.json({ current_streak: 0, longest_streak: 0, last_workout_date: null });
      }
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/streak/update', async (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

      const { data: existing } = await supabase
        .from('streaks')
        .select('*')
        .eq('user_id', req.user.id)
        .maybeSingle();

      let current_streak = 1;
      let forgiveness_used = existing?.forgiveness_used_this_week || false;
      let forgiveness_reset = existing?.forgiveness_reset_at || today;

      if (existing?.last_workout_date) {
        const last = existing.last_workout_date;

        // Reset forgiveness weekly
        const daysSinceReset = Math.floor((new Date(today) - new Date(forgiveness_reset)) / 86400000);
        if (daysSinceReset >= 7) {
          forgiveness_used = false;
          forgiveness_reset = today;
        }

        if (last === today) {
          // Already logged today — keep streak as is
          return res.json({ current_streak: existing.current_streak, already_logged: true });
        } else if (last === yesterday) {
          // Consecutive — extend streak
          current_streak = (existing.current_streak || 0) + 1;
        } else {
          // Gap — check forgiveness
          const daysSinceLast = Math.floor((new Date(today) - new Date(last)) / 86400000);
          if (daysSinceLast === 2 && !forgiveness_used) {
            // One missed day — forgiveness applies
            current_streak = (existing.current_streak || 0) + 1;
            forgiveness_used = true;
          } else {
            // Streak broken
            current_streak = 1;
          }
        }
      }

      const longest_streak = Math.max(current_streak, existing?.longest_streak || 0);

      await supabase.from('streaks').upsert({
        user_id: req.user.id,
        current_streak,
        longest_streak,
        last_workout_date: today,
        forgiveness_used_this_week: forgiveness_used,
        forgiveness_reset_at: forgiveness_reset,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

      res.json({ current_streak, longest_streak, is_new_record: current_streak === longest_streak && current_streak > 1 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── PUSH SUBSCRIPTIONS ────────────────────────
  router.post('/push/subscribe', async (req, res) => {
    try {
      const { subscription } = req.body;
      if (!subscription) return res.status(400).json({ error: 'No subscription provided' });

      await supabase.from('push_subscriptions').upsert({
        user_id: req.user.id,
        subscription
      }, { onConflict: 'user_id,subscription' });

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/push/subscribe', async (req, res) => {
    try {
      await supabase.from('push_subscriptions')
        .delete()
        .eq('user_id', req.user.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── PR CHECK ──────────────────────────────────
  router.post('/pr/check', async (req, res) => {
    try {
      const { exercise_name, weight_kg, reps, sets } = req.body;
      const est_1rm = Math.round(weight_kg * (1 + reps / 30));

      const { data: existing } = await supabase
        .from('personal_records')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('exercise_name', exercise_name)
        .maybeSingle();

      const is_pr = !existing || est_1rm > (existing.est_1rm || 0);

      if (is_pr) {
        await supabase.from('personal_records').upsert({
          user_id: req.user.id,
          exercise_name,
          weight_kg,
          reps,
          sets,
          est_1rm,
          achieved_at: new Date().toISOString().split('T')[0]
        }, { onConflict: 'user_id,exercise_name' });
      }

      res.json({
        is_pr,
        previous_1rm: existing?.est_1rm || null,
        new_1rm: est_1rm,
        improvement: existing ? est_1rm - existing.est_1rm : null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── PLAN ADHERENCE ────────────────────────────
  router.get('/adherence', async (req, res) => {
    try {
      const weeks = parseInt(req.query.weeks) || 4;
      const since = new Date(Date.now() - weeks * 7 * 86400000).toISOString().split('T')[0];

      const { data: sessions } = await supabase
        .from('session_logs')
        .select('logged_at')
        .eq('user_id', req.user.id)
        .gte('logged_at', since);

      const { data: plan } = await supabase
        .from('plans')
        .select('workout_plan')
        .eq('user_id', req.user.id)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const plannedDaysPerWeek = plan?.workout_plan?.days?.filter(d => d.exercises?.length > 0).length || 4;
      const totalPlanned = plannedDaysPerWeek * weeks;
      const uniqueDaysLogged = new Set((sessions || []).map(s => s.logged_at)).size;
      const adherence_pct = totalPlanned > 0 ? Math.round((uniqueDaysLogged / totalPlanned) * 100) : 0;

      res.json({
        adherence_pct: Math.min(100, adherence_pct),
        workouts_completed: uniqueDaysLogged,
        workouts_planned: totalPlanned,
        weeks
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── BODY METRICS ──────────────────────────────
  router.post('/metrics', async (req, res) => {
    try {
      const { weight_kg, body_fat_pct, chest_cm, waist_cm, hips_cm, arm_cm, thigh_cm, notes } = req.body;
      const today = new Date().toISOString().split('T')[0];

      const { data, error } = await supabase.from('body_metrics').insert({
        user_id: req.user.id,
        logged_at: today,
        weight_kg, body_fat_pct, chest_cm, waist_cm,
        hips_cm, arm_cm, thigh_cm, notes
      }).select().maybeSingle();

      if (error) throw error;
      res.json({ metric: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/metrics', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('body_metrics')
        .select('*')
        .eq('user_id', req.user.id)
        .order('logged_at', { ascending: false })
        .limit(52);

      if (error) throw error;
      res.json({ metrics: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/metrics/insights', async (req, res) => {
    try {
      const { data: metrics } = await supabase
        .from('body_metrics')
        .select('*')
        .eq('user_id', req.user.id)
        .order('logged_at', { ascending: false })
        .limit(8);

      const { data: profile } = await supabase
        .from('profiles')
        .select('goal, name')
        .eq('id', req.user.id)
        .maybeSingle();

      if (!metrics?.length) return res.json({ insights: 'Log some body metrics first to get insights.' });

      const latest = metrics[0];
      const oldest = metrics[metrics.length - 1];
      const weightChange = latest.weight_kg && oldest.weight_kg
        ? (latest.weight_kg - oldest.weight_kg).toFixed(1)
        : null;

      const prompt = `You are a fitness coach. Analyse these body metrics and give brief, direct insights.
Client: ${profile?.name}, Goal: ${profile?.goal}
Latest metrics: weight ${latest.weight_kg}kg, body fat ${latest.body_fat_pct || 'N/A'}%, waist ${latest.waist_cm || 'N/A'}cm
Change over ${metrics.length} entries: weight ${weightChange !== null ? weightChange + 'kg' : 'N/A'}
Give 2-3 sentences of specific, actionable insight. No fluff.`;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      });

      res.json({ insights: response.content[0].text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── DELOAD DETECTION ──────────────────────────
  router.get('/deload/check', async (req, res) => {
    try {
      const fourWeeksAgo = new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0];

      const { data: history } = await supabase
        .from('exercise_history')
        .select('*')
        .eq('user_id', req.user.id)
        .gte('logged_at', fourWeeksAgo)
        .order('logged_at', { ascending: true });

      if (!history?.length || history.length < 6) {
        return res.json({ needs_deload: false, reason: null });
      }

      // Group by exercise, check for volume plateau or drops
      const byExercise = {};
      history.forEach(h => {
        if (!byExercise[h.exercise_name]) byExercise[h.exercise_name] = [];
        byExercise[h.exercise_name].push(h);
      });

      let stalledCount = 0;
      let droppingCount = 0;

      Object.values(byExercise).forEach(sessions => {
        if (sessions.length < 3) return;
        const recent = sessions.slice(-3);
        const volumes = recent.map(s => s.volume || 0);
        const isStalled = volumes.every(v => Math.abs(v - volumes[0]) < volumes[0] * 0.05);
        const isDropping = volumes[2] < volumes[0] * 0.9;
        if (isStalled) stalledCount++;
        if (isDropping) droppingCount++;
      });

      const totalExercises = Object.keys(byExercise).length;
      const needs_deload = stalledCount >= totalExercises * 0.5 || droppingCount >= 2;

      // Check existing unacknowledged flag
      const { data: existingFlag } = await supabase
        .from('deload_flags')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('acknowledged', false)
        .maybeSingle();

      if (needs_deload && !existingFlag) {
        const reason = droppingCount >= 2 ? 'performance_drop' : 'volume_plateau';
        await supabase.from('deload_flags').insert({
          user_id: req.user.id,
          reason,
          flagged_at: new Date().toISOString().split('T')[0]
        });
        return res.json({ needs_deload: true, reason });
      }

      res.json({
        needs_deload,
        reason: existingFlag?.reason || (needs_deload ? 'volume_plateau' : null),
        flag: existingFlag || null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── ONBOARDING MISSIONS ───────────────────────
  router.get('/missions', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('onboarding_missions')
        .select('*')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: true });

      if (error) throw error;
      res.json({ missions: data || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/missions/:key/complete', async (req, res) => {
    try {
      const { key } = req.params;
      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from('onboarding_missions')
        .update({ completed: true, completed_at: now })
        .eq('user_id', req.user.id)
        .eq('mission_key', key)
        .select()
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.json({ mission: null, score: 0 }); // mission row doesn't exist yet

      // Update onboarding score on profile
      const { data: missions } = await supabase
        .from('onboarding_missions')
        .select('completed')
        .eq('user_id', req.user.id);

      const completedCount = (missions || []).filter(m => m.completed).length;
      await supabase.from('profiles')
        .update({ onboarding_score: completedCount })
        .eq('id', req.user.id);

      res.json({ mission: data, score: completedCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── DELOAD ACKNOWLEDGE ────────────────────────────────
  router.post('/deload/acknowledge', async (req, res) => {
    try {
      await supabase
        .from('deload_flags')
        .update({ acknowledged: true })
        .eq('user_id', req.user.id)
        .eq('acknowledged', false);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── WEEKLY REVIEW ─────────────────────────────
  router.get('/review/latest', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('weekly_reviews')
        .select('*')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      res.json({ review: data || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
