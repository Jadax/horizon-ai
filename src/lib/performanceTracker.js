/**
 * PERFORMANCE TRACKER — closes (part of) the loop this product's trend
 * engine originally flagged as a future step: pulling REAL view/like/
 * comment counts for videos that have actually gone live, so the
 * trend-scoring engine can eventually learn from what actually performed,
 * not just from cross-source corroboration at harvest time.
 *
 * Uses `videos.list?part=statistics` — cheap (1 quota unit per call, can
 * batch up to 50 IDs per call), no separate YouTube Analytics API needed.
 * Runs on a periodic cron (see src/index.js) rather than instantly, since
 * a video needs time to accumulate real signal after publishing.
 */
import { google } from "googleapis";
import { config, getChannelToken } from "../config.js";
import { supabase, logEvent } from "../supabase.js";

function youtubeClient(channelKey) {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  oauth2.setCredentials({ refresh_token: getChannelToken(channelKey) });
  return google.youtube({ version: "v3", auth: oauth2 });
}

/**
 * Refreshes stats for every published job whose video has had at least
 * `minAgeHours` to accumulate real engagement, and whose stats haven't
 * been refreshed in the last `refreshIntervalHours`.
 */
export async function refreshPublishedStats(minAgeHours = 6, refreshIntervalHours = 6) {
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000).toISOString();
  const staleCutoff = new Date(Date.now() - refreshIntervalHours * 60 * 60 * 1000).toISOString();

  const { data: jobs, error } = await supabase
    .from("pipeline_logs")
    .select("id, youtube_video_id, target_channel, stats_updated_at")
    .not("youtube_video_id", "is", null)
    .lte("publish_schedule", cutoff)
    .or(`stats_updated_at.is.null,stats_updated_at.lte.${staleCutoff}`)
    .limit(50); // videos.list accepts up to 50 IDs per call

  if (error || !jobs?.length) return;

  // Group by channel, since each channel needs its own OAuth credentials
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
        await supabase
          .from("pipeline_logs")
          .update({
            yt_views: parseInt(stats.viewCount || "0", 10),
            yt_likes: parseInt(stats.likeCount || "0", 10),
            yt_comments: parseInt(stats.commentCount || "0", 10),
            stats_updated_at: new Date().toISOString(),
          })
          .eq("id", j.id);
      }
      await logEvent("Performance Tracker", `Refreshed stats for ${channelJobs.length} video(s) on channel "${channelKey}"`);
    } catch (err) {
      await logEvent("Performance Tracker", `Stats refresh failed for channel "${channelKey}": ${err.message}`, { level: "warn" });
    }
  }
}
