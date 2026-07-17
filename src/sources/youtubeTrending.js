/**
 * YOUTUBE TRENDING — a direct signal of what's already working in
 * vertical/short format, right now. Reuses the same OAuth credentials
 * already wired for uploads (read-only videos.list call, ~1 quota unit —
 * negligible next to the ~1600-unit upload cost).
 *
 * NOTE: requires the refresh token to include a read scope
 * (youtube.readonly or youtube.force-ssl), not just youtube.upload. If
 * your token predates this, this source will fail gracefully with an
 * "insufficient authentication scopes" error and Agent 1 will skip it —
 * harmless, but see DEPLOYMENT_NOTES.md for how to add the scope.
 */
import { config } from "../config.js";

export async function fetchYouTubeTrending(regionCode = "US", maxResults = 10) {
  if (!config.google.refreshToken) return [];
  const { google } = await import("googleapis");
  const oauth2 = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  oauth2.setCredentials({ refresh_token: config.google.refreshToken });
  const yt = google.youtube({ version: "v3", auth: oauth2 });
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
