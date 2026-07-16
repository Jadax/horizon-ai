/**
 * AGENT 1 — THE TREND & MEDIA HARVESTER
 *
 * Two jobs:
 *  1. TOPIC: read public Reddit JSON feeds (and, for Gaming/Lore, wiki search
 *     APIs) to find a high-engagement topic for the niche.
 *  2. MEDIA: pull LICENSED vertical stock clips from Pexels/Pixabay matched
 *     to the niche's footage keywords. No third-party gameplay/highlight
 *     ripping — every clip URL that enters the timeline carries a license.
 */
import { config } from "../config.js";
import { logEvent } from "../supabase.js";

const UA = "HorizonAI/1.0 (autonomous content pipeline; contact via dashboard)";

// ── Topic harvesting ──────────────────────────────────────────────────────

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
    }));
}

/**
 * For Gaming/Lore we also query MediaWiki-powered wiki search to ground the
 * topic in an actual lore article the scriptwriter can paraphrase.
 * (Fandom + wiki.gg both expose the standard MediaWiki API.)
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
  for (const source of niche.target_sources) {
    try {
      if (source.startsWith("r/")) {
        const posts = await fetchTopReddit(source, 10);
        candidates.push(...posts.map((p) => ({ ...p, source })));
        await logEvent("Agent 1", `Scraped ${source}: ${posts.length} candidates`, { jobId });
      }
    } catch (err) {
      await logEvent("Agent 1", `Source ${source} failed: ${err.message}`, { jobId, level: "warn" });
    }
  }

  if (!candidates.length) throw new Error("No topic candidates found from any source");

  // Engagement score: comments weigh heavier than raw upvotes (discussion = retention topics)
  candidates.sort(
    (a, b) => b.score + b.num_comments * 3 - (a.score + a.num_comments * 3)
  );
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

  await logEvent("Agent 1", `Topic locked: "${top.title.slice(0, 80)}" (${top.score}↑ ${top.num_comments}💬)`, { jobId });
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
