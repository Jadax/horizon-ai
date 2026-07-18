/**
 * PERFORMANCE TRACKER — now also tracks revenue
 */
import { google } from "googleapis";
import { config, getChannelToken } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { trackRevenue, estimateRevenue } from "./monetization.js";

function youtubeClient(channelKey) {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  oauth2.setCredentials({ refresh_token: getChannelToken(channelKey) });
  return google.youtube({ version: "v3", auth: oauth2 });
}

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
          
          // Update affiliate_revenue in pipeline_logs
          await supabase
            .from("pipeline_logs")
            .update({ affiliate_revenue: revenue })
            .eq("id", j.id);
        }
      }
      await logEvent("Performance Tracker", `Refreshed stats for ${channelJobs.length} video(s) on channel "${channelKey}"`);
    } catch (err) {
      await logEvent("Performance Tracker", `Stats refresh failed for channel "${channelKey}": ${err.message}`, { level: "warn" });
    }
  }
}