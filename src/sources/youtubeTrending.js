/**
 * YOUTUBE TRENDING — a direct signal of what's already working in
 * vertical/short format, right now. Uses the shared youtubeClient factory so
 * dashboard-linked channels (Supabase linked_channels) resolve exactly like
 * uploads do — the old inline OAuth2 build only ever saw GOOGLE_REFRESH_TOKEN
 * from env and ignored every linked channel.
 *
 * NOTE: requires the token to include a read scope (youtube.readonly or
 * youtube.force-ssl), not just youtube.upload. If your token predates this,
 * this source fails gracefully with an "insufficient authentication scopes"
 * error and Agent 1 skips it — harmless.
 */
import { youtubeClient } from "../lib/youtubeClient.js";

export async function fetchYouTubeTrending(regionCode = "US", maxResults = 10) {
  const yt = await youtubeClient("primary");
  const { data } = await yt.videos.list({
    part: ["snippet"],
    chart: "mostPopular",
    regionCode,
    maxResults,
  });
  return (data.items || []).map((v) => ({
    title: v.snippet?.title || "",
    url: `https://youtube.com/watch?v=${v.id}`,
    selftext: (v.snippet?.description || "").slice(0, 500),
    pubDate: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt).getTime() : 0,
    score: 0,
    num_comments: 0,
    isYouTubeTrending: true,
  }));
}
