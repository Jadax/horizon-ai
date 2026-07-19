import { supabase, logEvent } from "../supabase.js";
import { invalidateTrendWeightCache } from "./trendScoring.js";

const DIMENSIONS = ["source_platform", "title_pattern", "duration_bucket"];

function weekStart(date = new Date()) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function durationBucket(seconds) {
  if (seconds <= 20) return "15-20s";
  if (seconds <= 60) return "21-60s";
  return "60s+";
}

function performanceScore(job) {
  const views = Number(job.yt_views || 0);
  if (!views) return 0;
  const engagementRate = (Number(job.yt_likes || 0) + Number(job.yt_comments || 0) * 2) / views;
  const retention = Number(job.yt_avg_view_percentage || 0) / 100;
  const ctr = Number(job.yt_ctr || 0) / 100;
  return views * (1 + engagementRate * 10) * (1 + retention) * (1 + ctr);
}

async function updatePosterior({ dimension, armKey, niche, success }) {
  const { data } = await supabase.from("bayesian_posteriors").select("*")
    .eq("dimension", dimension).eq("arm_key", armKey).eq("platform", "youtube").eq("niche", niche).maybeSingle();
  const alpha = Number(data?.alpha || 1) + (success ? 1 : 0);
  const beta = Number(data?.beta || 1) + (success ? 0 : 1);
  const samples = Number(data?.samples || 0) + 1;
  await supabase.from("bayesian_posteriors").upsert({
    dimension,
    arm_key: armKey,
    platform: "youtube",
    niche,
    alpha,
    beta,
    samples,
    posterior_mean: alpha / (alpha + beta),
    updated_at: new Date().toISOString(),
  }, { onConflict: "dimension,arm_key,platform,niche" });
}

export async function runWeeklyLearning(now = new Date()) {
  const runWeek = weekStart(now);
  const { data: existing } = await supabase.from("learning_runs").select("status").eq("week_start", runWeek).maybeSingle();
  if (existing?.status === "completed") return { skipped: true, weekStart: runWeek };
  await supabase.from("learning_runs").upsert({ week_start: runWeek, status: "running", started_at: now.toISOString() }, { onConflict: "week_start" });

  try {
    const maturityCutoff = new Date(now.getTime() - 7 * 86400000).toISOString();
    const { data: jobs, error } = await supabase.from("pipeline_logs")
      .select("id,niche,source_platform,title_pattern,duration_seconds,yt_views,yt_likes,yt_comments,yt_ctr,yt_avg_view_percentage,publish_schedule")
      .not("youtube_video_id", "is", null).lte("publish_schedule", maturityCutoff).not("yt_views", "is", null).limit(500);
    if (error) throw error;

    const unprocessed = [];
    for (const job of jobs || []) {
      const { data: seen } = await supabase.from("learning_outcomes").select("pipeline_log_id").eq("pipeline_log_id", job.id).maybeSingle();
      if (!seen) unprocessed.push(job);
    }
    const byNiche = Object.groupBy(unprocessed, (job) => job.niche || "unknown");
    const allByNiche = Object.groupBy(jobs || [], (job) => job.niche || "unknown");
    let observations = 0;
    for (const [niche, cohort] of Object.entries(byNiche)) {
      const historical = allByNiche[niche] || cohort;
      if (historical.length < 3) continue;
      const baseline = median(historical.map(performanceScore));
      for (const job of cohort) {
        const score = performanceScore(job);
        const success = score >= baseline && score > 0;
        const arms = {
          source_platform: job.source_platform || "unknown",
          title_pattern: job.title_pattern || "unknown",
          duration_bucket: durationBucket(Number(job.duration_seconds || 0)),
        };
        for (const dimension of DIMENSIONS) await updatePosterior({ dimension, armKey: arms[dimension], niche, success });
        await supabase.from("learning_outcomes").insert({
          pipeline_log_id: job.id,
          observed_at: now.toISOString(),
          cohort_key: `youtube:${niche}`,
          metric_value: score,
          cohort_median: baseline,
          success,
        });
        observations++;
      }
    }

    const { data: posteriors } = await supabase.from("bayesian_posteriors").select("*").gte("samples", 3).order("posterior_mean", { ascending: false }).limit(20);
    const recommendations = (posteriors || []).slice(0, 5).map((row) => `Prefer ${row.dimension}=${row.arm_key} for ${row.niche} (posterior ${(row.posterior_mean * 100).toFixed(0)}%, n=${row.samples}).`);
    if (!recommendations.length) recommendations.push("Collect at least three mature outcomes per strategy arm before changing production weights.");
    const report = { week_start: runWeek, observations, updated_trend_scoring_weights: posteriors || [], next_week_optimization_recommendations: recommendations };
    invalidateTrendWeightCache();
    await supabase.from("learning_runs").update({ status: "completed", completed_at: new Date().toISOString(), report }).eq("week_start", runWeek);
    await logEvent("Learner", `Weekly Bayesian update completed with ${observations} mature outcome(s)`);
    return report;
  } catch (error) {
    await supabase.from("learning_runs").update({ status: "failed", completed_at: new Date().toISOString(), error: error.message }).eq("week_start", runWeek);
    throw error;
  }
}
