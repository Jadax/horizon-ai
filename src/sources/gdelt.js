/**
 * GDELT PROJECT — a free, no-auth global news dataset backed by Google
 * Jigsaw. Indexes broadcast/print/web news across ~100 languages, updated
 * every 15 minutes. Most content pipelines never discover this exists —
 * it's a genuine free alternative to a $449/month enterprise news API.
 * https://www.gdeltproject.org/
 *
 * Rate limits are light on the free tier — a 429 here is not fatal, Agent 1
 * logs it and moves on to the next source.
 */
import { UA } from "./rss.js";

export async function fetchGDELT(query, maxrecords = 10) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(
    query
  )}&mode=ArtList&maxrecords=${maxrecords}&format=json&sort=DateDesc`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GDELT → HTTP ${res.status}`);
  const json = await res.json();
  return (json.articles || []).map((a) => ({
    title: a.title || "",
    url: a.url,
    selftext: "",
    pubDate: a.seendate ? new Date(a.seendate).getTime() : 0,
    score: 0,
    num_comments: 0,
    tone: a.tone,
  }));
}
