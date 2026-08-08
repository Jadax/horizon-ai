/**
 * PERFORMANCE TRACKER — now also tracks revenue
 */
import { supabase, logEvent } from "../supabase.js";
import { youtubeClient } from "./youtubeClient.js";
import { trackRevenue, estimateRevenue } from "./monetization.js";

export async function refreshPublishedStats(minAgeHours = 6, refreshIntervalHours = 6) {
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000).toISOString();
  const staleCutoff = new Date(Date.now() - refreshIntervalHours * 60 * 60 * 1000).toISOString();

  const { data: jobs, error } = await supabase
    .from("pipeline_logs")
    .select("id, niche, youtube_video_id, target_channel, stats_updated_at, title, description, affiliate_products, affiliate_revenue")
    .not("youtube_video_id", "is", null)
    .lte("publish_schedule", cutoff)
    .or(`stats_updated_at.is.null,stats_updated_at.lte.${staleCutoff}`)
    .limit(50);

  if (error || !jobs?.length) return;

  const byChannel = {};
  for (const j of jobs) {
    const key = j.target_channel || "primary";
    (byChannel[key] = byChannel[key] || []).push(j);
  }

  for (const [channelKey, channelJobs] of Object.entries(byChannel)) {
    try {
      const yt = youtubeClient(channelKey);
      const ids = channelJobs.map((j) => j.youtube_video_id);
      const { data } = await yt.videos.list({ part: ["statistics"], id: ids });
      const statsById = Object.fromEntries((data.items || []).map((v) => [v.id, v.statistics]));

      for (const j of channelJobs) {
        const stats = statsById[j.youtube_video_id];
        if (!stats) continue;
        
        const views = parseInt(stats.viewCount || "0", 10);
        const likes = parseInt(stats.likeCount || "0", 10);
        const comments = parseInt(stats.commentCount || "0", 10);
        
        await supabase
          .from("pipeline_logs")
          .update({
            yt_views: views,
            yt_likes: likes,
            yt_comments: comments,
            stats_updated_at: new Date().toISOString(),
          })
          .eq("id", j.id);

        // ─── TRACK REVENUE WITH REAL VIEW DATA ────────────────────
        const revenue = estimateRevenue(views, 'youtube', j.niche || 'default');
        // Only track if revenue > 0 and we have views
        if (views > 0 && revenue > 0) {
          await trackRevenue(j.id, 'youtube', revenue, views);
          
          // Estimated platform revenue is not affiliate revenue or payout data.
          await supabase
            .from("pipeline_logs")
            .update({ estimated_platform_revenue: revenue })
            .eq("id", j.id);
        }
      }
      await logEvent("Performance Tracker", `Refreshed stats for ${channelJobs.length} video(s) on channel "${channelKey}"`);
    } catch (err) {
      await logEvent("Performance Tracker", `Stats refresh failed for channel "${channelKey}": ${err.message}`, { level: "warn" });
    }
  }
}

// ─── POSTING-TIME OPTIMIZER ────────────────────────────────────────────
// Learns the niche's best publish UTC hour from real view data: every 6h the
// performance tracker refreshes yt_views on pipeline_logs, and each published
// job carries its publish_schedule, so we bucket jobs by UTC hour and return
// the hour with the highest average views. Falls back to the region-rotation
// defaults (agent5 nextPublishSlot) until the niche has enough samples.
const hourCache = new Map();
const HOUR_CACHE_TTL = 6 * 60 * 60 * 1000;

export async function learnedUploadHour(nicheName, { minSamples = 3 } = {}) {
  if (!nicheName) return null;
  const cached = hourCache.get(nicheName);
  if (cached && Date.now() - cached.at < HOUR_CACHE_TTL) return cached.hour;

  const { data, error } = await supabase
    .from("pipeline_logs")
    .select("publish_schedule, yt_views")
    .eq("niche", nicheName)
    .not("youtube_video_id", "is", null)
    .not("yt_views", "is", null)
    .not("publish_schedule", "is", null)
    .order("publish_schedule", { ascending: false })
    .limit(60);

  if (error || !data?.length || data.length < minSamples) return null;

  const byHour = new Map();
  for (const job of data) {
    const dt = new Date(job.publish_schedule);
    const hour = dt.getUTCHours() + dt.getUTCMinutes() / 60;
    const views = Number(job.yt_views) || 0;
    const entry = byHour.get(hour) || { sum: 0, n: 0 };
    entry.sum += views;
    entry.n += 1;
    byHour.set(hour, entry);
  }

  let bestHour = null;
  let bestAvg = -1;
  for (const [hour, entry] of byHour) {
    const avg = entry.sum / entry.n;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestHour = hour;
    }
  }
  hourCache.set(nicheName, { hour: bestHour, at: Date.now() });
  return bestHour;
}
