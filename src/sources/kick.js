/**
 * KICK source — trending streams and clips.
 * Kick has a public (undocumented) API at kick.com/api/v2.
 * No authentication required for basic endpoints.
 */
import { UA } from "./rss.js";

export async function fetchKickTrending(options = {}) {
  const results = [];
  try {
    // Top live streams
    const liveRes = await fetch("https://kick.com/api/v2/channels?limit=15&sort=viewers", {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (liveRes.ok) {
      const liveData = await liveRes.json();
      for (const ch of (liveData.data || liveData || []).slice(0, 10)) {
        const stream = ch.livestream || ch;
        results.push({
          title: `🎮 ${ch.user?.username || ch.slug}: ${(stream.session_title || ch.slug || "Live").slice(0, 80)}`,
          url: `https://kick.com/${ch.slug || ch.user?.username || ""}`,
          selftext: `${stream.session_title || ""} — ${((stream.viewer_count || 0)).toLocaleString()} watching · ${ch.category?.name || "Gaming"}`,
          source: "kick_stream",
          score: Math.min(10, Math.log10((stream.viewer_count || 1) + 1) * 2),
          metrics: { viewers: stream.viewer_count || 0, category: ch.category?.name },
        });
      }
    }

    // Top clips (Kick supports clip endpoints)
    const clipsRes = await fetch("https://kick.com/api/v2/clips?sort=views&limit=10", {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    if (clipsRes.ok) {
      const clipsData = await clipsRes.json();
      for (const clip of (clipsData.data || clipsData || []).slice(0, 10)) {
        results.push({
          title: clip.title?.slice(0, 80) || `Kick clip by ${clip.creator?.username || "unknown"}`,
          url: clip.clip_url || clip.url || `https://kick.com/${clip.channel?.slug}/clips/${clip.id}`,
          selftext: `Viral clip: ${clip.title || ""} — ${clip.views?.toLocaleString() || 0} views`,
          source: "kick_clip",
          score: Math.min(10, Math.log10((clip.views || 1) + 1) * 1.8),
          metrics: { views: clip.views || 0, creator: clip.creator?.username },
        });
      }
    }
  } catch (err) {
    console.warn("[kick] fetch failed:", err.message);
  }
  return results.sort((a, b) => b.score - a.score);
}
