const UA = "HorizonAI/1.0 (autonomous content pipeline; contact via dashboard)";

// Reddit rate-limits unauthenticated requests aggressively, and a single
// pipeline run legitimately asks for the same subreddits twice (video pass +
// topic pass) across several niches back-to-back — production runs saw every
// subreddit 429 at once. Three mitigations, no auth needed:
//   1. per-run cache (5 min TTL) so the second pass never re-fetches,
//   2. ≥10s spacing between actual Reddit calls,
//   3. one retry after a 15s backoff on 429.
// Transport stays .rss: Reddit 403s unauthenticated .json requests from this
// UA (verified live) while serving .rss fine, so RSS it is — scores come
// back 0, which the trend ranker tolerates (other signals still apply).
const redditCache = new Map();
const REDDIT_CACHE_TTL = 5 * 60 * 1000;
let lastRedditCall = 0;

async function paceRedditCall() {
  const wait = lastRedditCall + 10000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRedditCall = Date.now();
}

export async function fetchTopReddit(subreddit, limit = 15, sort = 'hot') {
  const cleanSub = subreddit.replace(/^r\//, '');
  const cacheKey = `${cleanSub}/${sort}`;
  const cached = redditCache.get(cacheKey);
  if (cached && Date.now() - cached.at < REDDIT_CACHE_TTL) return cached.items.slice(0, limit);

  const url = `https://www.reddit.com/r/${cleanSub}/${sort}.rss`;
  for (let attempt = 1; ; attempt++) {
    await paceRedditCall();
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/atom+xml' } });
    if (res.status === 429 && attempt === 1) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    if (!res.ok) throw new Error(`Reddit r/${cleanSub} → HTTP ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
      const entry = m[1];
      const pick = (tag) => entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] || '';
      const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const link = entry.match(/<link href="([^"]+)"/)?.[1] || '';
      const published = pick('updated') || pick('published');
      return {
        title: decode(pick('title')),
        url: decode(link),
        selftext: decode(pick('content')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200),
        pubDate: published ? new Date(published).getTime() : Date.now(),
        score: 0,
        num_comments: 0,
      };
    }).filter((p) => p.title);
    redditCache.set(cacheKey, { at: Date.now(), items });
    return items.slice(0, limit);
  }
}

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