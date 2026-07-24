/**
 * TWITCH source — trending clips, top streams, and categories.
 * Uses Twitch's official Helix API (free application registration).
 * https://dev.twitch.tv/docs/api
 *
 * Requires: TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET (free at dev.twitch.tv)
 * Falls back gracefully if not configured.
 */
import { config } from "../config.js";
import { logEvent } from "../supabase.js";
import { UA } from "./rss.js";

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const clientId = process.env.TWITCH_CLIENT_ID || config.twitchClientId;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET || config.twitchClientSecret;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
    });
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    return cachedToken;
  } catch {
    return null;
  }
}

async function twitchApi(path) {
  const token = await getAccessToken();
  const clientId = process.env.TWITCH_CLIENT_ID || config.twitchClientId;
  if (!token || !clientId) return null;

  const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { "Client-ID": clientId, Authorization: `Bearer ${token}`, "User-Agent": UA },
  });
  if (!res.ok) return null;
  return await res.json();
}

export async function fetchTwitchTrending(options = {}) {
  const results = [];
  try {
    const gameId = options.gameId || "509658"; // "Just Chatting" default
    const streamData = await twitchApi(`streams?first=10&game_id=${gameId}`);
    if (streamData?.data) {
      for (const stream of streamData.data) {
        results.push({
          title: `🔥 ${stream.user_name}: ${stream.title?.slice(0, 80) || "Live now!"}`,
          url: `https://twitch.tv/${stream.user_login}`,
          selftext: `${stream.title} — ${stream.viewer_count.toLocaleString()} watching`,
          source: "twitch_stream",
          score: Math.min(10, Math.log10(stream.viewer_count + 1) * 2),
          metrics: { viewers: stream.viewer_count, game: stream.game_name },
        });
      }
    }

    // Top clips as topic candidates
    const clipData = await twitchApi(`clips?first=10&game_id=${gameId}&started_at=${new Date(Date.now()-86400000).toISOString()}`);
    if (clipData?.data) {
      for (const clip of clipData.data) {
        results.push({
          title: clip.title?.slice(0, 80) || "Twitch clip",
          url: clip.url,
          selftext: `Clip from ${clip.broadcaster_name} — ${clip.view_count} views`,
          source: "twitch_clip",
          score: Math.min(10, Math.log10(clip.view_count + 1) * 1.8),
          metrics: { views: clip.view_count, creator: clip.broadcaster_name },
        });
      }
    }
  } catch (err) {
    console.warn("[twitch] fetch failed:", err.message);
  }
  return results.sort((a, b) => b.score - a.score);
}
