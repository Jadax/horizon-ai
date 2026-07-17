/**
 * AGENT 1 — THE TREND & MEDIA HARVESTER
 *
 * This file is intentionally thin: it pulls from the source modules in
 * src/sources/, hands everything to the trend-scoring engine in
 * src/lib/trendScoring.js, and separately sources LICENSED stock footage
 * from Pexels/Pixabay. Each concern lives in its own small file — see
 * src/sources/*.js for the individual integrations.
 */
import { config } from "../config.js";
import { logEvent } from "../supabase.js";
import { fetchRSSFeed } from "../sources/rss.js";
import { fetchSocialRSSFeeds, normaliseSocialFeeds } from "../sources/socialRss.js";
import { fetchGoogleTrends, fetchGoogleNews } from "../sources/googleTrends.js";
import { fetchGDELT } from "../sources/gdelt.js";
import { fetchYouTubeTrending } from "../sources/youtubeTrending.js";
import { fetchMastodonHashtag, fetchLemmyHot } from "../sources/fediverse.js";
import { fetchTopReddit, searchWiki } from "../sources/reddit.js";
import { rankCandidates, recalibrateWeights } from "../lib/trendScoring.js";

// ── Topic harvesting ──────────────────────────────────────────────────────

/**
 * Pulls every configured source for a niche and returns the FULL ranked
 * list (not just the winner) — used both by the pipeline (which takes the
 * top result) and by the ad-hoc "check what's trending" dashboard tool
 * (which shows the whole ranked list for a human to browse).
 */
export async function harvestAllCandidates(niche, jobId = null) {
  const log = (msg, level) => (jobId ? logEvent("Agent 1", msg, { jobId, level }) : logEvent("Agent 1", msg, { level }));
  await log(`Scanning sources for ${niche.niche_name}…`);

  const candidates = [];
  const tag = (items, source) => items.map((i) => ({ ...i, source }));

  // Primary: niche-specific publisher RSS feeds
  for (const feedUrl of niche.rss_feeds || []) {
    try {
      const items = await fetchRSSFeed(feedUrl);
      candidates.push(...tag(items, new URL(feedUrl).hostname));
      await log(`RSS ${new URL(feedUrl).hostname}: ${items.length} candidates`);
    } catch (err) {
      await log(`RSS feed failed (${feedUrl}): ${err.message}`, "warn");
    }
  }

  // Platform-specific public/authorised feeds. These are RSS/Atom sources,
  // not HTML scrapers: no login bypassing, paywall circumvention, or copying
  // platform video assets into the render pipeline.
  const socialFeeds = normaliseSocialFeeds(niche.social_rss_feeds);
  if (socialFeeds.length) {
    const results = await fetchSocialRSSFeeds(socialFeeds, config.socialFeedHeaders);
    for (const result of results) {
      if (result.error) {
        await log(`Social RSS feed failed: ${result.error.message}`, "warn");
        continue;
      }
      candidates.push(...tag(result.items, result.source));
      await log(`${result.source}: ${result.items.length} candidates`);
    }
  }

  // Google Trends — broad cultural-relevance signal, every niche
  try {
    const trends = await fetchGoogleTrends(niche.trend_region || "US");
    candidates.push(...tag(trends, "Google Trends"));
    await log(`Google Trends: ${trends.length} candidates`);
  } catch (err) {
    await log(`Google Trends fetch failed: ${err.message}`, "warn");
  }

  // YouTube Trending — proven vertical/short-format signal, every niche
  try {
    const ytTrending = await fetchYouTubeTrending(niche.trend_region || "US", 8);
    candidates.push(...tag(ytTrending, "YouTube Trending"));
    if (ytTrending.length) await log(`YouTube Trending: ${ytTrending.length} candidates`);
  } catch (err) {
    await log(`YouTube Trending fetch failed: ${err.message}`, "warn");
  }

  // Fediverse (Mastodon + Lemmy) — genuine open-API hidden gems, per niche
  for (const tagName of niche.mastodon_tags || []) {
    try {
      const posts = await fetchMastodonHashtag(tagName);
      candidates.push(...tag(posts, "Mastodon"));
      await log(`Mastodon #${tagName}: ${posts.length} candidates`);
    } catch (err) {
      await log(`Mastodon #${tagName} failed: ${err.message}`, "warn");
    }
  }
  for (const community of niche.lemmy_communities || []) {
    try {
      const posts = await fetchLemmyHot(community);
      candidates.push(...tag(posts, "Lemmy"));
      await log(`Lemmy c/${community}: ${posts.length} candidates`);
    } catch (err) {
      await log(`Lemmy c/${community} failed: ${err.message}`, "warn");
    }
  }

  // News niche gets two dedicated free, no-auth global news sources
  if (niche.niche_name === "News") {
    try {
      const gdelt = await fetchGDELT("breaking OR viral OR trending", 12);
      candidates.push(...tag(gdelt, "GDELT"));
      await log(`GDELT: ${gdelt.length} candidates`);
    } catch (err) {
      await log(`GDELT fetch failed: ${err.message}`, "warn");
    }
    try {
      const gnews = await fetchGoogleNews(null);
      candidates.push(...tag(gnews, "Google News"));
      await log(`Google News: ${gnews.length} candidates`);
    } catch (err) {
      await log(`Google News fetch failed: ${err.message}`, "warn");
    }
  }

  // Best-effort: Reddit (usually 403s since May 2026, harmless if so)
  for (const source of niche.target_sources || []) {
    if (!source.startsWith("r/")) continue;
    try {
      const posts = await fetchTopReddit(source, 10);
      candidates.push(...tag(posts, "Reddit (best-effort)"));
      await log(`Scraped ${source}: ${posts.length} candidates`);
    } catch (err) {
      await log(`Source ${source} failed: ${err.message}`, "warn");
    }
  }

  if (!candidates.length) return [];
  return rankCandidates(candidates);
}

export async function harvestTopic(niche, jobId) {
  const ranked = await harvestAllCandidates(niche, jobId);
  if (!ranked.length) throw new Error("No topic candidates found from any source");

  const top = ranked[0];

  // Lore grounding — configurable per niche via lore_wiki_apis (MediaWiki
  // API roots). Any fan wiki with a standard MediaWiki install works here;
  // Lexicanum (Warhammer 40k) and wiki.gg (Elden Ring) are both wired by
  // default for Gaming/Lore, and more can be added per niche in Supabase
  // without touching code.
  let loreContext = null;
  const wikiApis = niche.lore_wiki_apis || [];
  for (const apiRoot of wikiApis) {
    const wikiResults = await searchWiki(apiRoot, top.title.split(" ").slice(0, 6).join(" ")).catch(() => []);
    if (wikiResults.length) {
      loreContext = wikiResults;
      await logEvent("Agent 1", `Lore grounding found (${new URL(apiRoot).hostname}): "${wikiResults[0].title}"`, { jobId });
      break;
    }
  }

  await logEvent(
    "Agent 1",
    `Topic locked: "${top.title.slice(0, 80)}" (source: ${top.source}, trend score: ${top._trendScore}, corroborated by ${top._corroborationCount} source${top._corroborationCount > 1 ? "s" : ""})`,
    { jobId }
  );

  // Self-adjust source-reliability weights based on this run's corroboration pattern
  recalibrateWeights(ranked).catch(() => {});

  return { topic: top, loreContext };
}

// ── Licensed footage sourcing (unchanged — Pexels/Pixabay only) ──────────

async function searchPexels(keyword, perPage = 3) {
  if (!config.pexelsKey) return [];
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(
    keyword
  )}&orientation=portrait&size=medium&per_page=${perPage}`;
  const res = await fetch(url, { headers: { Authorization: config.pexelsKey } });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.videos || []).map((v) => {
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

export async function harvestFootage(niche, jobId, minTotalSeconds = 55, priorityKeywords = null, visualQueries = []) {
  await logEvent("Agent 1", `Sourcing licensed b-roll for ${niche.niche_name}…`, { jobId });
  // If the Format Decision Engine picked a mood-matched keyword subset for
  // this specific topic, search those first, then fill in with the rest
  // of the niche's keywords (shuffled) if more footage is still needed.
  const scriptedQueries = Array.isArray(visualQueries)
    ? visualQueries.map((q) => q?.query).filter((q) => typeof q === "string" && q.trim()).slice(0, 12)
    : [];
  const rest = niche.footage_keywords.filter((k) => !priorityKeywords?.includes(k));
  const keywords = scriptedQueries.length
    ? [...scriptedQueries, ...rest.sort(() => Math.random() - 0.5)]
    : priorityKeywords?.length
    ? [...priorityKeywords, ...rest.sort(() => Math.random() - 0.5)]
    : [...niche.footage_keywords].sort(() => Math.random() - 0.5);
  const clips = [];
  let total = 0;

  for (const kw of keywords) {
    if (total >= minTotalSeconds) break;
    const found = [...(await searchPexels(kw)), ...(await searchPixabay(kw))]
      .filter((c) => c.url && c.duration >= 4);
    for (const clip of found.slice(0, 2)) {
      const matchingBrief = visualQueries.find((q) => q?.query === kw);
      clips.push({ ...clip, keyword: kw, semanticCue: matchingBrief?.line || kw, visualIntent: matchingBrief?.intent || null });
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
