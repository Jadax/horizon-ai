/**
 * DAILYMOTION source — trending videos, channels, and search.
 * Dailymotion has a public REST API (no key required for basic access).
 * https://developers.dailymotion.com/api/
 */
const DM_API = "https://api.dailymotion.com";

export async function fetchDailymotionTrending(options = {}) {
  const results = [];
  try {
    const fields = "id,title,description,channel.name,views_total,created_time,thumbnail_720_url,tags,duration";
    const res = await fetch(
      `${DM_API}/videos?fields=${fields}&sort=trending&limit=10&flags=no_live,exportable&language=en`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return [];
    const data = await res.json();

    for (const video of (data.list || [])) {
      results.push({
        title: video.title?.slice(0, 80) || "Dailymotion video",
        url: `https://dailymotion.com/video/${video.id}`,
        selftext: video.description?.slice(0, 300) || "",
        source: "dailymotion",
        score: Math.min(10, Math.log10((video.views_total || 1) + 1) * 1.9),
        metrics: { views: video.views_total, channel: video["channel.name"], tags: video.tags },
      });
    }
  } catch (err) {
    console.warn("[dailymotion] fetch failed:", err.message);
  }
  return results.sort((a, b) => b.score - a.score);
}

export async function searchDailymotion(query, options = {}) {
  const results = [];
  try {
    const fields = "id,title,description,channel.name,views_total,created_time,thumbnail_720_url";
    const res = await fetch(
      `${DM_API}/videos?fields=${fields}&search=${encodeURIComponent(query)}&sort=relevance&limit=10`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return [];
    const data = await res.json();

    for (const video of (data.list || [])) {
      results.push({
        title: video.title?.slice(0, 80) || "Dailymotion video",
        url: `https://dailymotion.com/video/${video.id}`,
        selftext: video.description?.slice(0, 300) || "",
        source: "dailymotion_search",
        score: Math.min(10, Math.log10((video.views_total || 100) + 1) * 1.7),
        metrics: { views: video.views_total },
      });
    }
  } catch (err) {
    console.warn("[dailymotion] search failed:", err.message);
  }
  return results;
}
