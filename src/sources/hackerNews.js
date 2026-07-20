/**
 * HACKER NEWS — via Algolia's official public search API (no key, no auth,
 * generous limits). Front-page stories are pre-filtered by the strongest
 * human curation signal available for tech/culture topics: thousands of
 * technical readers upvoting. Titles are real editorial-quality headlines,
 * unlike raw social posts.
 */
import { UA } from "./rss.js";

export async function fetchHackerNewsTop(limit = 12) {
  const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HN Algolia → HTTP ${res.status}`);
  const json = await res.json();
  return (json.hits || []).map((hit) => ({
    title: String(hit.title || "").slice(0, 200),
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    selftext: String(hit.story_text || "").replace(/<[^>]+>/g, " ").slice(0, 1200),
    pubDate: hit.created_at ? new Date(hit.created_at).getTime() : 0,
    score: hit.points || 0,
    num_comments: hit.num_comments || 0,
  })).filter((item) => item.title.length >= 15);
}
