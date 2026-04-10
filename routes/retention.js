const express = require('express');
const router = express.Router();

// These are injected via module.exports factory
module.exports = function(supabase, anthropic) {

  // ════════════════════════════════════════════════
  // STREAK SYSTEM (with 1 forgiveness/week)
  // ════════════════════════════════════════════════

  // GET current streak
  router.get('/streak', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('streaks')
        .select('*')
        .eq('user_id', req.user.id)
        .single();

      if (error && error.code === 'PGRST116') {
        // No streak record yet
        return res.json({ current_streak: 0, longest_streak: 0, forgiveness_available: true });
      }
      if (error) throw error;

      // Reset forgiveness weekly (Monday)
      const now = new Date();
      const resetDate = new Date(data.forgiveness_reset_at);
      const daysSinceReset = Math.floor((now - resetDate) / 86400000);
      const forgivenessAvailable = daysSinceReset >= 7 ? true : !data.forgiveness_used_this_week;

      res.json({
        current_streak: data.current_streak,
        longest_streak: data.longest_streak,
        last_workout_date: data.last_workout_date,
        forgiveness_available: forgivenessAvailable
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST update streak (called after workout log)
  router.post('/streak/update', async (req, res) => {
    try {
      const userId = req.user.id;
      const today = new Date().toISOString().split('T')[0];

      const { data: existing } = await supabase
        .from('streaks')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (!existing) {
        // First workout ever
        const { data, error } = await supabase
          .from('streaks')
          .insert({
            user_id: userId,
            current_streak: 1,
            longest_streak: 1,
            last_workout_date: today,
            forgiveness_reset_at: today
          })
          .select()
          .single();
        if (error) throw error;
        return res.json({ streak: data, milestone: 1 });
      }

      // Calculate days since last workout
      const lastDate = new Date(existing.last_workout_date);
      const todayDate = new Date(today);
      const daysDiff = Math.floor((todayDate - lastDate) / 86400000);

      let newStreak = existing.current_streak;
      let forgUsed = existing.forgiveness_used_this_week;
      let milestone = null;

      if (daysDiff === 0) {
        // Already logged today
        return res.json({ streak: existing, milestone: null });
      } else if (daysDiff === 1) {
        // Consecutive day
        newStreak += 1;
      } else if (daysDiff === 2 && !forgUsed) {
        // Missed one day — use forgiveness
        newStreak += 1;
        forgUsed = true;
      } else {
        // Streak broken
        newStreak = 1;
        forgUsed = false;
      }

      // Reset forgiveness weekly
      const resetDate = new Date(existing.forgiveness_reset_at);
      const daysSinceReset = Math.floor((todayDate - resetDate) / 86400000);
      if (daysSinceReset >= 7) {
        forgUsed = false;
      }

      const longest = Math.max(newStreak, existing.longest_streak);

      // Check milestones
      const milestones = [3, 7, 14, 30, 60, 100];
      if (milestones.includes(newStreak)) {
        milestone = newStreak;
      }

      const { data, error } = await supabase
        .from('streaks')
        .update({
          current_streak: newStreak,
          longest_streak: longest,
          last_workout_date: today,
          forgiveness_used_this_week: forgUsed,
          forgiveness_reset_at: daysSinceReset >= 7 ? today : existing.forgiveness_reset_at,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      res.json({ streak: data, milestone });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════
  // PUSH NOTIFICATIONS
  // ════════════════════════════════════════════════

  // POST subscribe to push
  router.post('/push/subscribe', async (req, res) => {
    try {
      const { subscription } = req.body;
      if (!subscription) return res.status(400).json({ error: 'Subscription required' });

      const { error } = await supabase
        .from('push_subscriptions')
        .upsert({
          user_id: req.user.id,
          subscription
        }, { onConflict: 'user_id,subscription' });

      if (error) throw error;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE unsubscribe
  router.delete('/push/subscribe', async (req, res) => {
    try {
      const { endpoint } = req.body;
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', req.user.id)
        .filter('subscription->>endpoint', 'eq', endpoint);

      if (error) throw error;
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════
  // PR DETECTION + CELEBRATION
  // ════════════════════════════════════════════════

  // POST check for new PRs after logging
  router.post('/pr/check', async (req, res) => {
    try {
      const { exercise_name, weight_kg, reps, sets } = req.body;
      const userId = req.user.id;
      const est1rm = weight_kg * (1 + reps / 30); // Epley formula

      // Get existing PR
      const { data: existingPR } = await supabase
        .from('personal_records')
        .select('*')
        .eq('user_id', userId)
        .eq('exercise_name', exercise_name)
        .single();

      let isPR = false;
      let prType = null;

      if (!existingPR) {
        // First ever record for this exercise
        isPR = true;
        prType = 'first_record';
      } else if (est1rm > (existingPR.est_1rm || 0)) {
        isPR = true;
        prType = 'new_1rm';
      } else if (weight_kg > (existingPR.weight_kg || 0)) {
        isPR = true;
        prType = 'new_weight';
      } else if (weight_kg === existingPR.weight_kg && reps > (existingPR.reps || 0)) {
        isPR = true;
        prType = 'new_reps';
      }

      if (isPR) {
        // Upsert PR
        await supabase
          .from('personal_records')
          .upsert({
            user_id: userId,
            exercise_name,
            weight_kg,
            reps,
            sets,
            est_1rm: est1rm,
            achieved_at: new Date().toISOString().split('T')[0]
          }, { onConflict: 'user_id,exercise_name' });

        // Complete onboarding mission if applicable
        await checkMission(userId, 'first_workout');
      }

      res.json({
        is_pr: isPR,
        pr_type: prType,
        exercise: exercise_name,
        est_1rm: isPR ? est1rm : null,
        previous_1rm: existingPR?.est_1rm || null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════
  // PLAN ADHERENCE TRACKING
  // ════════════════════════════════════════════════

  router.get('/adherence', async (req, res) => {
    try {
      const userId = req.user.id;
      const { weeks = 4 } = req.query;

      // Get user's plan
      const { data: plan } = await supabase
        .from('plans')
        .select('workout_plan')
        .eq('user_id', userId)
        .order('generated_at', { ascending: false })
        .limit(1)
        .single();

      if (!plan) return res.json({ adherence_pct: null, message: 'No plan generated yet' });

      const plannedDaysPerWeek = Object.keys(plan.workout_plan || {}).length || 0;

      // Get sessions from last N weeks
      const since = new Date();
      since.setDate(since.getDate() - (weeks * 7));

      const { data: sessions } = await supabase
        .from('session_logs')
        .select('logged_at')
        .eq('user_id', userId)
        .gte('logged_at', since.toISOString().split('T')[0]);

      const totalPlanned = plannedDaysPerWeek * weeks;
      const totalLogged = sessions?.length || 0;
      const adherencePct = totalPlanned > 0 ? Math.round((totalLogged / totalPlanned) * 100) : 0;

      res.json({
        adherence_pct: Math.min(adherencePct, 100),
        workouts_logged: totalLogged,
        workouts_planned: totalPlanned,
        weeks_tracked: parseInt(weeks)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════
  // BODY METRICS + AI INSIGHTS
  // ════════════════════════════════════════════════

  router.post('/metrics', async (req, res) => {
    try {
      const { weight_kg, body_fat_pct, chest_cm, waist_cm, hips_cm, arm_cm, thigh_cm, notes } = req.body;

      const { data, error } = await supabase
        .from('body_metrics')
        .insert({
          user_id: req.user.id,
          weight_kg, body_fat_pct, chest_cm, waist_cm, hips_cm, arm_cm, thigh_cm, notes
        })
        .select()
        .single();

      if (error) throw error;

      // Complete onboarding mission
      await checkMission(req.user.id, 'log_bodyweight');

      res.json(data);
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
        .limit(30);

      if (error) throw error;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/metrics/insights', async (req, res) => {
    try {
      const userId = req.user.id;

      const { data: metrics } = await supabase
        .from('body_metrics')
        .select('*')
        .eq('user_id', userId)
        .order('logged_at', { ascending: false })
        .limit(10);

      const { data: profile } = await supabase
        .from('profiles')
        .select('goal, target_weight_kg')
        .eq('id', userId)
        .single();

      if (!metrics || metrics.length < 2) {
        return res.json({ insights: 'Log at least 2 body metrics entries to get AI insights.' });
      }

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `You are a fitness coach. Analyse these body metrics and give 3 brief, actionable insights.
Goal: ${profile?.goal || 'general fitness'}
Target weight: ${profile?.target_weight_kg || 'not set'}kg
Metrics (newest first): ${JSON.stringify(metrics.map(m => ({
  date: m.logged_at, weight: m.weight_kg, bf: m.body_fat_pct,
  waist: m.waist_cm, chest: m.chest_cm
})))}
Keep it under 150 words. Be direct. No fluff.`
        }]
      });

      res.json({ insights: message.content[0].text });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════
  // DELOAD DETECTION
  // ════════════════════════════════════════════════

  router.get('/deload/check', async (req, res) => {
    try {
      const userId = req.user.id;

      // Get last 4 weeks of exercise history
      const since = new Date();
      since.setDate(since.getDate() - 28);

      const { data: history } = await supabase
        .from('exercise_history')
        .select('logged_at, volume, est_1rm')
        .eq('user_id', userId)
        .gte('logged_at', since.toISOString().split('T')[0])
        .order('logged_at', { ascending: true });

      if (!history || history.length < 8) {
        return res.json({ needs_deload: false, reason: 'Not enough data yet' });
      }

      // Split into weeks
      const weeks = [[], [], [], []];
      history.forEach(h => {
        const weekIdx = Math.floor((new Date(h.logged_at) - since) / (7 * 86400000));
        if (weekIdx >= 0 && weekIdx < 4) weeks[weekIdx].push(h);
      });

      const weeklyVolumes = weeks.map(w =>
        w.reduce((sum, e) => sum + (e.volume || 0), 0)
      );

      const weeklyAvg1rm = weeks.map(w => {
        const rms = w.filter(e => e.est_1rm).map(e => e.est_1rm);
        return rms.length ? rms.reduce((a, b) => a + b, 0) / rms.length : 0;
      });

      let needsDeload = false;
      let reason = null;

      // Check: 3+ weeks of declining or stagnant 1RM
      if (weeklyAvg1rm[3] > 0 && weeklyAvg1rm[2] > 0 && weeklyAvg1rm[1] > 0) {
        if (weeklyAvg1rm[3] <= weeklyAvg1rm[2] && weeklyAvg1rm[2] <= weeklyAvg1rm[1]) {
          needsDeload = true;
          reason = 'performance_plateau';
        }
      }

      // Check: volume dropping while effort stays high
      if (weeklyVolumes[3] > 0 && weeklyVolumes[3] < weeklyVolumes[1] * 0.85) {
        needsDeload = true;
        reason = reason || 'volume_decline';
      }

      if (needsDeload) {
        // Flag it
        await supabase
          .from('deload_flags')
          .insert({ user_id: userId, reason });
      }

      res.json({
        needs_deload: needsDeload,
        reason,
        weekly_volumes: weeklyVolumes,
        weekly_avg_1rm: weeklyAvg1rm
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════
  // ONBOARDING MISSIONS (Day 1–7)
  // ════════════════════════════════════════════════

  router.get('/missions', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('onboarding_missions')
        .select('*')
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: true });

      if (error) throw error;

      const completed = (data || []).filter(m => m.completed).length;
      const total = (data || []).length;

      res.json({
        missions: data,
        progress: { completed, total, pct: total > 0 ? Math.round((completed / total) * 100) : 0 }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/missions/:key/complete', async (req, res) => {
    try {
      const { key } = req.params;
      const userId = req.user.id;

      const { data, error } = await supabase
        .from('onboarding_missions')
        .update({ completed: true, completed_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('mission_key', key)
        .eq('completed', false)
        .select()
        .single();

      if (error) throw error;

      // Update onboarding score
      await supabase
        .from('profiles')
        .update({ onboarding_score: supabase.rpc ? undefined : undefined })
        .eq('id', userId);

      // Count completed
      const { count } = await supabase
        .from('onboarding_missions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('completed', true);

      await supabase
        .from('profiles')
        .update({ onboarding_score: count })
        .eq('id', userId);

      res.json({ mission: data, total_completed: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════
  // WEEKLY REVIEW (endpoint for cron to hit)
  // ════════════════════════════════════════════════

  router.get('/review/latest', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('weekly_reviews')
        .select('*')
        .eq('user_id', req.user.id)
        .order('week_start', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code === 'PGRST116') {
        return res.json({ review: null });
      }
      if (error) throw error;
      res.json({ review: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Helper: check and complete onboarding mission
  async function checkMission(userId, missionKey) {
    try {
      await supabase
        .from('onboarding_missions')
        .update({ completed: true, completed_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('mission_key', missionKey)
        .eq('completed', false);
    } catch (e) {
      // Non-critical, don't throw
    }
  }

  return router;
};
