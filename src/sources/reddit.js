/**
 * REDDIT — best-effort only. Reddit deprecated unauthenticated .json
 * access on May 28-30, 2026 (see DEPLOYMENT_NOTES.md); commercial API
 * access now requires a $12k/year minimum, not viable here. This is kept
 * only because it's harmless to try and occasionally still returns data
 * from some IPs/regions — never treat it as a primary source.
 */
import { UA } from "./rss.js";

export async function fetchTopReddit(subreddit, limit = 15) {
  const url = `https://www.reddit.com/${subreddit}/top.json?t=day&limit=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Reddit ${subreddit} → HTTP ${res.status}`);
  const json = await res.json();
  return (json?.data?.children || [])
    .map((c) => c.data)
    .filter((p) => !p.over_18 && !p.stickied)
    .map((p) => ({
      title: p.title,
      score: p.score,
      num_comments: p.num_comments,
      url: `https://reddit.com${p.permalink}`,
      selftext: (p.selftext || "").slice(0, 1200),
      pubDate: (p.created_utc || 0) * 1000,
    }));
}

/**
 * WIKI LORE GROUNDING — MediaWiki search API (Fandom, wiki.gg, and most
 * fan wikis all expose this standard endpoint). Used to ground a Gaming
 * niche topic in a real lore article the scriptwriter paraphrases — a
 * completely separate, stable, open API unaffected by Reddit's lockdown.
 */
export async function searchWiki(apiRoot, query) {
  const url = `${apiRoot}?action=query&list=search&srsearch=${encodeURIComponent(
    query
  )}&format=json&srlimit=3`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const json = await res.json();
  return (json?.query?.search || []).map((r) => ({
    title: r.title,
    snippet: r.snippet?.replace(/<[^>]+>/g, ""),
  }));
}
