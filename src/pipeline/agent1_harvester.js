/**
 * AGENT 1 — THE TREND & MEDIA HARVESTER
 *
 * Topic sourcing, as of July 2026:
 *   Reddit deprecated unauthenticated .json access on May 28-30, 2026 (see
 *   DEPLOYMENT_NOTES.md) — commercial API access now requires a $12k/year
 *   minimum commitment, not viable here. Reddit is kept below as a
 *   best-effort bonus source (harmless if it 403s, occasionally still
 *   works from some IPs/regions), but the PRIMARY topic sources are now:
 *     - Real publisher RSS feeds per niche (IGN, PC Gamer, Psychology
 *       Today, Lonely Planet, etc.) — free, no auth, stable, unlikely to
 *       ever be locked down the way Reddit was.
 *     - Google Trends' official public RSS feed (trends.google.com/trending/rss)
 *       — free, no auth, gives a broad "what's culturally hot right now"
 *       signal layered on top of the niche-specific feeds.
 *
 * Media sourcing (Pexels/Pixabay licensed stock footage) is unchanged.
 */
import Parser from "rss-parser";
import { config } from "../config.js";
import { logEvent } from "../supabase.js";

const UA = "HorizonAI/1.0 (autonomous content pipeline; contact via dashboard)";
const rssParser = new Parser({ headers: { "User-Agent": UA }, timeout: 10000 });

// ── RSS topic harvesting (primary) ───────────────────────────────────────

async function fetchRSSFeed(feedUrl) {
  const feed = await rssParser.parseURL(feedUrl);
  return (feed.items || []).slice(0, 8).map((item) => ({
    title: item.title || "",
    url: item.link || feedUrl,
    selftext: (item.contentSnippet || item.content || "").slice(0, 1200),
    pubDate: item.pubDate ? new Date(item.pubDate).getTime() : 0,
    score: 0,
    num_comments: 0,
  }));
}

async function fetchGoogleTrends(geo = "US") {
  const feedUrl = `https://trends.google.com/trending/rss?geo=${geo}`;
  const feed = await rssParser.parseURL(feedUrl);
  return (feed.items || []).slice(0, 10).map((item) => ({
    title: item.title || "",
    url: item.link || feedUrl,
    selftext: (item.contentSnippet || item.content || "").slice(0, 800),
    pubDate: item.pubDate ? new Date(item.pubDate).getTime() : 0,
    score: 0,
    num_comments: 0,
    isGoogleTrend: true,
  }));
}

/**
 * Google News RSS — free, no auth, no key. Two modes:
 *  - no query: the general top-stories feed for a country/language
 *  - with query: a topic-scoped search feed (used for niche-flavored news)
 */
async function fetchGoogleNews(query, hl = "en-US", gl = "US") {
  const feedUrl = query
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`
    : `https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`;
  const feed = await rssParser.parseURL(feedUrl);
  return (feed.items || []).slice(0, 10).map((item) => ({
    title: item.title || "",
    url: item.link || feedUrl,
    selftext: (item.contentSnippet || item.content || "").slice(0, 800),
    pubDate: item.pubDate ? new Date(item.pubDate).getTime() : 0,
    score: 0,
    num_comments: 0,
  }));
}

/**
 * GDELT Project — a free, no-auth global news dataset (backed by Google
 * Jigsaw) that indexes broadcast/print/web news across ~100 languages,
 * updated every 15 minutes. A genuinely underused source most pipelines
 * never discover: https://www.gdeltproject.org/
 */
async function fetchGDELT(query, maxrecords = 10) {
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

/**
 * YouTube's own "trending" chart — a direct signal of what's currently
 * working as short/vertical-friendly content. Reuses the same OAuth
 * credentials already wired for uploads (read-only videos.list call,
 * costs ~1 quota unit, negligible next to the ~1600-unit upload cost).
 */
async function fetchYouTubeTrending(regionCode = "US", maxResults = 10) {
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

// ── Reddit (best-effort only — see header note) ──────────────────────────

async function fetchTopReddit(subreddit, limit = 15) {
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
 * For Gaming/Lore we also query MediaWiki-powered wiki search to ground the
 * topic in an actual lore article the scriptwriter can paraphrase.
 * (Fandom + wiki.gg both expose the standard MediaWiki API — unaffected by
 * Reddit's lockdown, this is a separate, stable, open API.)
 */
async function searchWiki(apiRoot, query) {
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

export async function harvestTopic(niche, jobId) {
  await logEvent("Agent 1", `Scanning sources for ${niche.niche_name}…`, { jobId });

  const candidates = [];

  // Primary: niche-specific RSS feeds
  for (const feedUrl of niche.rss_feeds || []) {
    try {
      const items = await fetchRSSFeed(feedUrl);
      candidates.push(...items.map((i) => ({ ...i, source: feedUrl })));
      await logEvent("Agent 1", `RSS ${new URL(feedUrl).hostname}: ${items.length} candidates`, { jobId });
    } catch (err) {
      await logEvent("Agent 1", `RSS feed failed (${feedUrl}): ${err.message}`, { jobId, level: "warn" });
    }
  }

  // Supplementary: Google Trends daily feed — broad cultural-relevance signal
  try {
    const trends = await fetchGoogleTrends("US");
    candidates.push(...trends.map((i) => ({ ...i, source: "Google Trends" })));
    await logEvent("Agent 1", `Google Trends: ${trends.length} candidates`, { jobId });
  } catch (err) {
    await logEvent("Agent 1", `Google Trends fetch failed: ${err.message}`, { jobId, level: "warn" });
  }

  // News niche gets two extra dedicated free sources: GDELT (global news
  // dataset) and Google News' own top-stories feed. Other niches skip
  // these to stay on-topic (RSS feeds above already cover them).
  if (niche.niche_name === "News") {
    try {
      const gdelt = await fetchGDELT("breaking OR viral OR trending", 12);
      candidates.push(...gdelt.map((i) => ({ ...i, source: "GDELT" })));
      await logEvent("Agent 1", `GDELT: ${gdelt.length} candidates`, { jobId });
    } catch (err) {
      await logEvent("Agent 1", `GDELT fetch failed: ${err.message}`, { jobId, level: "warn" });
    }
    try {
      const gnews = await fetchGoogleNews(null);
      candidates.push(...gnews.map((i) => ({ ...i, source: "Google News" })));
      await logEvent("Agent 1", `Google News: ${gnews.length} candidates`, { jobId });
    } catch (err) {
      await logEvent("Agent 1", `Google News fetch failed: ${err.message}`, { jobId, level: "warn" });
    }
  }

  // YouTube Trending — genuine signal of what's already working in
  // short/vertical format right now. Pulled for every niche as a light
  // supplementary source (read-only, ~1 quota unit).
  try {
    const ytTrending = await fetchYouTubeTrending("US", 8);
    candidates.push(...ytTrending.map((i) => ({ ...i, source: "YouTube Trending" })));
    if (ytTrending.length) {
      await logEvent("Agent 1", `YouTube Trending: ${ytTrending.length} candidates`, { jobId });
    }
  } catch (err) {
    await logEvent("Agent 1", `YouTube Trending fetch failed: ${err.message}`, { jobId, level: "warn" });
  }

  // Best-effort: Reddit (usually 403s since May 2026, harmless if so)
  for (const source of niche.target_sources || []) {
    if (!source.startsWith("r/")) continue;
    try {
      const posts = await fetchTopReddit(source, 10);
      candidates.push(...posts.map((p) => ({ ...p, source })));
      await logEvent("Agent 1", `Scraped ${source}: ${posts.length} candidates`, { jobId });
    } catch (err) {
      await logEvent("Agent 1", `Source ${source} failed: ${err.message}`, { jobId, level: "warn" });
    }
  }

  if (!candidates.length) throw new Error("No topic candidates found from any source");

  // Rank: Reddit engagement score first if present, otherwise most recent.
  // Google Trends / YouTube Trending items get a boost since they signal
  // broad, already-proven relevance rather than just "recently published."
  candidates.sort((a, b) => {
    const scoreA =
      (a.score || 0) + (a.num_comments || 0) * 3 +
      (a.isGoogleTrend ? 500 : 0) + (a.isYouTubeTrending ? 400 : 0);
    const scoreB =
      (b.score || 0) + (b.num_comments || 0) * 3 +
      (b.isGoogleTrend ? 500 : 0) + (b.isYouTubeTrending ? 400 : 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b.pubDate || 0) - (a.pubDate || 0);
  });
  const top = candidates[0];

  // Lore grounding for gaming niche
  let loreContext = null;
  if (niche.niche_name === "Gaming/Lore") {
    const wikiResults = await searchWiki(
      "https://eldenring.wiki.gg/api.php",
      top.title.split(" ").slice(0, 6).join(" ")
    ).catch(() => []);
    if (wikiResults.length) {
      loreContext = wikiResults;
      await logEvent("Agent 1", `Lore grounding found: "${wikiResults[0].title}"`, { jobId });
    }
  }

  await logEvent(
    "Agent 1",
    `Topic locked: "${top.title.slice(0, 80)}" (source: ${top.source})`,
    { jobId }
  );
  return { topic: top, loreContext };
}


// ── Licensed footage sourcing ────────────────────────────────────────────

async function searchPexels(keyword, perPage = 3) {
  if (!config.pexelsKey) return [];
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(
    keyword
  )}&orientation=portrait&size=medium&per_page=${perPage}`;
  const res = await fetch(url, { headers: { Authorization: config.pexelsKey } });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.videos || []).map((v) => {
    // Prefer HD portrait file closest to 1080x1920
    const file =
      v.video_files
        .filter((f) => f.height >= f.width)
        .sort((a, b) => Math.abs(a.height - 1920) - Math.abs(b.height - 1920))[0] ||
      v.video_files[0];
    return {
      url: file.link,
      duration: v.duration,
      width: file.width,
      height: file.height,
      provider: "pexels",
      license: "Pexels License (free commercial use)",
      credit: v.user?.name,
    };
  });
}

async function searchPixabay(keyword, perPage = 3) {
  if (!config.pixabayKey) return [];
  const url = `https://pixabay.com/api/videos/?key=${config.pixabayKey}&q=${encodeURIComponent(
    keyword
  )}&per_page=${perPage}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.hits || []).map((v) => ({
    url: v.videos?.large?.url || v.videos?.medium?.url,
    duration: v.duration,
    width: v.videos?.large?.width,
    height: v.videos?.large?.height,
    provider: "pixabay",
    license: "Pixabay Content License (free commercial use)",
    credit: v.user,
  }));
}

/**
 * Gather enough licensed clips to cover ~50s of timeline.
 */
export async function harvestFootage(niche, jobId, minTotalSeconds = 55) {
  await logEvent("Agent 1", `Sourcing licensed b-roll for ${niche.niche_name}…`, { jobId });
  const keywords = [...niche.footage_keywords].sort(() => Math.random() - 0.5);
  const clips = [];
  let total = 0;

  for (const kw of keywords) {
    if (total >= minTotalSeconds) break;
    const found = [...(await searchPexels(kw)), ...(await searchPixabay(kw))]
      .filter((c) => c.url && c.duration >= 4);
    for (const clip of found.slice(0, 2)) {
      clips.push({ ...clip, keyword: kw });
      total += Math.min(clip.duration, 8);
      if (total >= minTotalSeconds) break;
    }
    await logEvent("Agent 1", `"${kw}" → ${found.length} licensed clips (${Math.round(total)}s gathered)`, { jobId });
  }

  if (clips.length < 3) {
    throw new Error(
      "Insufficient licensed footage — check PEXELS_API_KEY / PIXABAY_API_KEY or broaden footage_keywords"
    );
  }
  await logEvent("Agent 1", `Media locked: ${clips.length} clips, ~${Math.round(total)}s of coverage`, { jobId });
  return clips;
}
