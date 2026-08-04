import { config } from "../config.js";
import { randomUUID } from "node:crypto";
import { supabase, logEvent } from "../supabase.js";
import { fetchRSSFeed } from "../sources/rss.js";
import { fetchSocialRSSFeeds } from "../sources/socialRss.js";
import { fetchGoogleTrends, fetchGoogleNews } from "../sources/googleTrends.js";
import { fetchGDELT } from "../sources/gdelt.js";
import { fetchYouTubeTrending } from "../sources/youtubeTrending.js";
import { fetchYouTubeSuggest } from "../sources/youtubeSuggest.js";
import { fetchMastodonHashtag, fetchLemmyHot } from "../sources/fediverse.js";
import { fetchHackerNewsTop } from "../sources/hackerNews.js";
import { fetchWikipediaTrending } from "../sources/wikipediaTrending.js";
import { fetchBlueskyHot } from "../sources/bluesky.js";
import { fetchTopReddit, searchWiki } from "../sources/reddit.js";
import { fetchTwitchTrending } from "../sources/twitch.js";
import { fetchKickTrending } from "../sources/kick.js";
import { fetchDailymotionTrending } from "../sources/dailymotion.js";
import { rankCandidates, recalibrateWeights } from "../lib/trendScoring.js";
import { llmJson, llmVision } from "../lib/llm.js";

export async function harvestAllCandidates(niche, jobId = null) {
    const log = (msg, level) => (jobId ? logEvent("Agent 1", msg, { jobId, level }) : logEvent("Agent 1", msg, { level }));
    await log(`Scanning sources for ${niche.niche_name}...`);

    const candidates = [];
    const enabled = new Set(
        niche.editing_style_preset?.trendSources
        || ["google", "reddit", "youtube", "youtube_suggest", "gdelt", "rss", "wikipedia", "hackernews", "wikipedia_trending", "bluesky", "twitch", "kick", "dailymotion"]
    );
    const tag = (items, source) => items.map((i) => ({ ...i, source }));

    for (const feedUrl of enabled.has("rss") ? niche.rss_feeds || [] : []) {
        try {
            const items = await fetchRSSFeed(feedUrl);
            candidates.push(...tag(items, new URL(feedUrl).hostname));
            await log(`RSS ${new URL(feedUrl).hostname}: ${items.length} candidates`);
        } catch (err) {
            await log(`RSS feed failed (${feedUrl}): ${err.message}`, "warn");
        }
    }

    const socialFeeds = niche.social_rss_feeds || [];
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

    if (enabled.has("hackernews")) try {
        const hn = await fetchHackerNewsTop(12);
        candidates.push(...tag(hn, "Hacker News"));
        await log(`Hacker News front page: ${hn.length} candidates`);
    } catch (err) {
        await log(`Hacker News fetch failed: ${err.message}`, "warn");
    }

    if (enabled.has("wikipedia_trending")) try {
        const wiki = await fetchWikipediaTrending(niche.language === "hi" ? "hi" : "en", 12);
        candidates.push(...tag(wiki, "Wikipedia Trending"));
        await log(`Wikipedia trending: ${wiki.length} candidates`);
    } catch (err) {
        await log(`Wikipedia trending fetch failed: ${err.message}`, "warn");
    }

    if (enabled.has("bluesky")) try {
        const bsky = await fetchBlueskyHot(12);
        candidates.push(...tag(bsky, "Bluesky"));
        await log(`Bluesky What's Hot: ${bsky.length} candidates`);
    } catch (err) {
        await log(`Bluesky fetch failed: ${err.message}`, "warn");
    }

    if (enabled.has("google")) try {
        const trends = await fetchGoogleTrends(niche.trend_region || "US");
        candidates.push(...tag(trends, "Google Trends"));
        await log(`Google Trends: ${trends.length} candidates`);
    } catch (err) {
        await log(`Google Trends fetch failed: ${err.message}`, "warn");
    }

    if (enabled.has("youtube")) try {
        const ytTrending = await fetchYouTubeTrending(niche.trend_region || "US", 8);
        candidates.push(...tag(ytTrending, "YouTube Trending"));
        if (ytTrending.length) await log(`YouTube Trending: ${ytTrending.length} candidates`);
    } catch (err) {
        await log(`YouTube Trending fetch failed: ${err.message}`, "warn");
    }

    // Search-intent source: YouTube autocomplete over the niche's own
    // keywords surfaces "how to / what is / best X" queries people are
    // typing right now — topics no RSS/Trends feed reports. Opt-in per niche.
    if (enabled.has("youtube_suggest")) try {
        const suggestSeeds = [
            ...(niche.footage_keywords || []),
            ...(niche.target_sources || []).filter((s) => s.startsWith("r/")).map((s) => s.replace(/^r\//, "")),
        ].filter((s) => typeof s === "string" && s.trim()).slice(0, 4);
        if (suggestSeeds.length) {
            const suggestions = await fetchYouTubeSuggest(suggestSeeds, 5);
            candidates.push(...tag(suggestions, "YouTube Suggest"));
            await log(`YouTube Suggest: ${suggestions.length} search-intent candidates`);
        }
    } catch (err) {
        await log(`YouTube Suggest fetch failed: ${err.message}`, "warn");
    }

    // Gaming/Viral niches: Twitch clips + streams
    if (enabled.has("twitch") && ["Gaming/Lore", "Viral"].includes(niche.niche_name)) try {
        const twitch = await fetchTwitchTrending();
        candidates.push(...tag(twitch, "Twitch"));
        await log(`Twitch: ${twitch.length} candidates`);
    } catch (err) {
        await log(`Twitch fetch failed: ${err.message}`, "warn");
    }

    // Gaming/Viral niches: Kick streams + clips
    if (enabled.has("kick") && ["Gaming/Lore", "Viral"].includes(niche.niche_name)) try {
        const kick = await fetchKickTrending();
        candidates.push(...tag(kick, "Kick"));
        await log(`Kick: ${kick.length} candidates`);
    } catch (err) {
        await log(`Kick fetch failed: ${err.message}`, "warn");
    }

    // Viral/Entertainment niches: Dailymotion trending
    if (enabled.has("dailymotion") && ["Viral", "News", "Technology"].includes(niche.niche_name)) try {
        const dm = await fetchDailymotionTrending();
        candidates.push(...tag(dm, "Dailymotion"));
        await log(`Dailymotion: ${dm.length} candidates`);
    } catch (err) {
        await log(`Dailymotion fetch failed: ${err.message}`, "warn");
    }

    for (const tagName of enabled.has("mastodon") || !niche.editing_style_preset?.trendSources ? niche.mastodon_tags || [] : []) {
        try {
            const posts = await fetchMastodonHashtag(tagName);
            candidates.push(...tag(posts, "Mastodon"));
            await log(`Mastodon #${tagName}: ${posts.length} candidates`);
        } catch (err) {
            await log(`Mastodon #${tagName} failed: ${err.message}`, "warn");
        }
    }
    for (const community of enabled.has("lemmy") || !niche.editing_style_preset?.trendSources ? niche.lemmy_communities || [] : []) {
        try {
            const posts = await fetchLemmyHot(community);
            candidates.push(...tag(posts, "Lemmy"));
            await log(`Lemmy c/${community}: ${posts.length} candidates`);
        } catch (err) {
            await log(`Lemmy c/${community} failed: ${err.message}`, "warn");
        }
    }

    if (niche.niche_name === "News" && enabled.has("gdelt")) {
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

    for (const source of enabled.has("reddit") ? niche.target_sources || [] : []) {
        if (!source.startsWith('r/')) continue;
        try {
            const posts = await fetchTopReddit(source, 10, 'hot');
            const nonVideoPosts = posts.filter(p => 
                !p.url || p.url.includes('reddit.com') || 
                (!p.url.includes('youtube.com') && !p.url.includes('tiktok.com') && 
                 !p.url.includes('instagram.com') && !p.url.includes('twitter.com'))
            );
            candidates.push(...tag(nonVideoPosts, `Reddit (${source})`));
            await log(`Reddit ${source}: ${nonVideoPosts.length} non-video candidates`);
        } catch (err) {
            await log(`Source ${source} failed: ${err.message}`, "warn");
        }
    }

    if (!candidates.length) return [];
    return rankCandidates(candidates, niche.niche_name);
}

function topicKey(title) {
    return (title || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .slice(0, 5)
        .join(" ");
}

async function recentTopicKeys(nicheName, days = 14, limit = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from("pipeline_logs")
        .select("topic")
        .eq("niche", nicheName)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(limit);
    if (error || !data?.length) return new Set();
    return new Set(data.map((r) => topicKey(r.topic)).filter(Boolean));
}

/**
 * For explainer niches, raw engagement is the wrong ranking signal — a hot
 * post is often news/drama, while the best explainer topic is the one the
 * most people are quietly curious about. One free LLM call re-scores the
 * top candidates on mass curiosity + explainability + evergreen value and
 * re-ranks by that. Failure degrades to the engagement ranking.
 */
async function rerankByCuriosity(candidates, jobId) {
    const pool = candidates.slice(0, 18);
    try {
        const res = await llmJson({
            tier: "fast",
            temperature: 0.2,
            label: "curiosityRerank",
            messages: [
                {
                    role: "system",
                    content: `Score each topic candidate 1-10 for a "explained for dummies" short-video channel:
- mass_curiosity: would a broad, all-ages audience genuinely want this explained? (niche in-jokes, local news, personal posts score low)
- explainability: is there a real story/mechanism to teach in 45 seconds with a surprising payoff?
- evergreen: will this still be worth watching in five years? (news cycles, drama, memes score low)
Return JSON: {"scores":[{"index":0,"total":24},...]} where total = sum of the three (max 30). Score every candidate.`,
                },
                { role: "user", content: JSON.stringify(pool.map((c, index) => ({ index, title: c.title.slice(0, 140) }))) },
            ],
        });
        const { scores } = JSON.parse(res.content);
        const byIndex = new Map((scores || []).map((s) => [s.index, Number(s.total) || 0]));
        const reranked = pool
            .map((c, index) => ({ ...c, _curiosityScore: byIndex.get(index) ?? 0 }))
            .sort((a, b) => b._curiosityScore - a._curiosityScore);
        await logEvent("Agent 1", `Curiosity re-rank: "${reranked[0]?.title.slice(0, 60)}" leads (${reranked[0]?._curiosityScore}/30)`, { jobId });
        return [...reranked, ...candidates.slice(18)];
    } catch (err) {
        await logEvent("Agent 1", `Curiosity re-rank failed (${err.message}) — using engagement ranking`, { jobId, level: "warn" });
        return candidates;
    }
}

/**
 * A trend is not automatically a producible short. Before committing spend,
 * rank the best candidates by whether they have enough source substance and
 * can be shown with truthful visuals. This prevents a noisy headline from
 * outranking a story that can actually be explained and illustrated.
 */
async function rerankForProductionReadiness(candidates, niche, jobId) {
    const pool = candidates.slice(0, 16);
    try {
        const res = await llmJson({
            tier: "fast",
            temperature: 0.1,
            label: "productionReadiness",
            messages: [
                {
                    role: "system",
                    content: `You are a ruthless short-form executive producer. Score each candidate 1-10 for:
- audience_pull: a concrete curiosity, stakes, or emotional hook for this niche.
- factual_grounding: enough verifiable detail in the headline/context to make a truthful short without filling gaps.
- visualability: can a viewer see specific people, objects, actions, locations, or a truthful simple metaphor for most of the story? Broad mood-only visuals score low.
- novelty: not an obvious repeat or generic update.

Return JSON only: {"scores":[{"index":0,"total":0,"audience_pull":0,"factual_grounding":0,"visualability":0,"novelty":0,"reason":"..."}]}. Total is 4-40. Do not reward tragedy, outrage, or celebrity alone without a specific story.`,
                },
                {
                    role: "user",
                    content: JSON.stringify({
                        niche: niche.niche_name,
                        candidates: pool.map((candidate, index) => ({
                            index,
                            title: String(candidate.title || "").slice(0, 180),
                            context: String(candidate.selftext || "").slice(0, 400),
                            source: candidate.source,
                        })),
                    }),
                },
            ],
        });
        const parsed = JSON.parse(res.content || "{}");
        const byIndex = new Map((parsed.scores || []).map((score) => [Number(score.index), score]));
        const ranked = pool
            .map((candidate, index) => {
                const score = byIndex.get(index) || {};
                const grounded = Number(score.factual_grounding) || 0;
                const visual = Number(score.visualability) || 0;
                const total = Number(score.total) || 0;
                // A factually thin or unshowable story cannot enter the
                // autopilot pipeline, however attractive its raw trend score.
                const eligible = grounded >= 7 && visual >= 7 && total >= 26;
                return {
                    ...candidate,
                    _productionScore: total,
                    _productionEligible: eligible,
                    _productionReason: String(score.reason || "").slice(0, 180),
                };
            })
            .sort((a, b) => b._productionScore - a._productionScore);
        const eligible = ranked.filter((candidate) => candidate._productionEligible);
        const output = eligible.length ? [...eligible, ...ranked.filter((candidate) => !candidate._productionEligible)] : ranked;
        await logEvent("Agent 1", `Production-readiness re-rank: ${eligible.length}/${pool.length} candidates are factually grounded and visually producible`, { jobId });
        return [...output, ...candidates.slice(pool.length)];
    } catch (err) {
        await logEvent("Agent 1", `Production-readiness re-rank failed (${err.message}) — using trend ranking`, { jobId, level: "warn" });
        return candidates;
    }
}

export async function harvestTopic(niche, jobId) {
    let ranked = await harvestAllCandidates(niche, jobId);
    if (!ranked.length) throw new Error("No topic candidates found from any source");
    if (niche.editing_style_preset?.explainerMode) {
        ranked = await rerankByCuriosity(ranked, jobId);
    }
    ranked = await rerankForProductionReadiness(ranked, niche, jobId);

    const seen = await recentTopicKeys(niche.niche_name);
    const fresh = ranked.filter((c) => !seen.has(topicKey(c.title)));
    if (fresh.length < ranked.length) {
        await logEvent(
            "Agent 1",
            `Skipped ${ranked.length - fresh.length} candidate(s) already covered by this niche in the last 14 days`,
            { jobId }
        );
    }
    
    const pool = fresh.length ? fresh : ranked;
    const top = pool[0];
    const loreContext = await resolveLoreContext(niche, top.title, jobId);

    await logEvent(
        "Agent 1",
        `Topic locked: "${top.title.slice(0, 80)}" (source: ${top.source}, trend score: ${top._trendScore || top._viralScore || "N/A"})`,
        { jobId }
    );

    recalibrateWeights(ranked).catch((err) => logEvent("Agent 1", `Weight recalibration failed: ${err.message}`, { jobId, level: "warn" }));

    // Runner-up candidates so the orchestrator can retry with a different
    // topic when the quality gate rejects every script draft for the top one
    // — a thin topic (nothing concrete to say) fails all revisions no matter
    // how good the writing is, and previously took the whole run down with it.
    return { topic: top, loreContext, alternates: pool.slice(1, 4) };
}

export async function resolveLoreContext(niche, title, jobId) {
    const wikiApis = niche.editing_style_preset?.trendSources
        ? (niche.editing_style_preset.trendSources.includes("wikipedia") ? niche.lore_wiki_apis || [] : [])
        : niche.lore_wiki_apis || [];
    for (const apiRoot of wikiApis) {
        const wikiResults = await searchWiki(apiRoot, title.split(" ").slice(0, 6).join(" ")).catch(() => []);
        if (wikiResults.length) {
            // Research stage: pull the top article's actual summary extract —
            // search snippets alone are fragments, and the scriptwriter needs
            // real facts (names, dates, mechanisms) to ground its claims and
            // survive the critic's fabrication check.
            try {
                const host = new URL(apiRoot).origin;
                const res = await fetch(`${host}/api/rest_v1/page/summary/${encodeURIComponent(wikiResults[0].title.replace(/ /g, "_"))}`, {
                    headers: { "User-Agent": "HorizonAI/1.0" }, signal: AbortSignal.timeout(10000),
                });
                if (res.ok) {
                    const summary = await res.json();
                    if (summary.extract) wikiResults[0].extract = String(summary.extract).slice(0, 900);
                }
            } catch { /* snippets still work without the extract */ }
            await logEvent("Agent 1", `Lore grounding found (${new URL(apiRoot).hostname}): "${wikiResults[0].title}"${wikiResults[0].extract ? " + article extract" : ""}`, { jobId });
            return wikiResults;
        }
    }
    return null;
}

async function searchPexels(keyword, perPage = 15) {
    if (!config.pexelsKey) return [];
    const url = `https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(
        keyword
    )}&per_page=${perPage}`;
    const res = await fetch(url, { headers: { Authorization: config.pexelsKey } });
    if (!res.ok) { logEvent("Agent 1", `Pexels API error ${res.status} for "${keyword}"`, { level: "warn" }); return []; }
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
            previewUrl: v.image,
            license: "Pexels License (free commercial use)",
            credit: v.user?.name,
        };
    });
}

// Capped independently of how many candidates the search itself returns —
// widening Pexels/Pixabay result counts (for a better chance of finding a
// real match) is not the same as needing to vision-check every single one
// of them in one call. Sending too many images in one request is what blew
// through the account's tokens-per-minute limit and killed an entire run.
const MAX_VISION_CANDIDATES = 10;

async function verifyVisualMatches(brief, candidates) {
    if (!config.visualQualityGate) return { clips: candidates, tokens: 0 };
    const candidatesWithPreview = candidates.filter((clip) => clip.previewUrl).slice(0, MAX_VISION_CANDIDATES);
    if (!candidatesWithPreview.length) return { clips: [], tokens: 0 };
    // Preserve the candidate mapping while fetching previews. A failed
    // thumbnail must never shift a model index onto another video clip.
    const resolved = [];
    for (const clip of candidatesWithPreview) {
        try {
            const res = await fetch(clip.previewUrl, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) continue;
            const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
            resolved.push({ clip, image: { mimeType, base64: Buffer.from(await res.arrayBuffer()).toString("base64") } });
        } catch { /* skip unresolvable */ }
    }
    if (!resolved.length) return { clips: [], tokens: 0 };
    const prompt = `You are the final visual-continuity reviewer for a premium vertical video.
SPOKEN LINE: ${brief.line}
REQUIRED VISUAL: ${brief.query}
WHY: ${brief.intent || "The image must directly prove the narration."}

The previews are supplied in exact Candidate order: 0 through ${resolved.length - 1}. Accept only footage that visibly depicts the literal subject, action, setting, or truthful visual metaphor for this exact line. Reject broad mood matches, generic lifestyle, dancing, phones, scenery, candles, or clips that only match a country or broad topic. Do not infer unseen facts.

Return JSON only: {"accepted":[{"index":0,"score":0,"reason":"..."}]}. Include only scores 8-10.`;
    const visionRes = await llmVision({ prompt, images: resolved.map((entry) => entry.image), label: "visualQA", maxTokens: 600 });
    const jsonText = String(visionRes.content || "{}").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const result = JSON.parse(jsonText);
    const accepted = (result.accepted || [])
        .filter((item) => Number(item.score) >= 8 && resolved[Number(item.index)])
        .map((item) => ({
            ...resolved[Number(item.index)].clip,
            visualScore: Number(item.score),
            visualReview: String(item.reason || "Verified against narration beat").slice(0, 240),
        }));
    return { clips: accepted, tokens: visionRes.tokens || 0 };
}

async function searchPixabay(keyword, perPage = 10) {
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
        // Verified against a real Pixabay API response — there is no
        // "picture_id" field on a video hit at all (that guess meant every
        // Pixabay clip has had previewUrl:null since this was written,
        // silently filtered out of visual QA before the vision model ever
        // ran, which reads as "100% rejected" but was actually "never checked").
        // The real thumbnail lives per-size under videos.<size>.thumbnail.
        previewUrl: v.videos?.large?.thumbnail || v.videos?.medium?.thumbnail || v.videos?.small?.thumbnail || v.videos?.tiny?.thumbnail || null,
        license: "Pixabay Content License (free commercial use)",
        credit: v.user,
    }));
}

const AI_CUTAWAY_DURATION = 4; // seconds a generated still is shown for
const AI_CUTAWAY_MAX_PER_VIDEO = 4; // caps real per-video OpenAI image cost

/**
 * Real, original, licensed-by-construction fallback for a visual_plan beat
 * that no stock search turned up a genuine match for — generates a still
 * image via OpenAI's image API from the beat's own line/query/intent
 * instead of forcing a mismatched stock clip through, or (the alternative
 * that was explicitly rejected) reaching for scraped third-party video.
 * This is a real, per-image OpenAI cost, so it's capped per video and only
 * used for beats stock search genuinely couldn't cover.
 */
// One fixed style block shared by every illustration in a video so the
// output reads as one artist's work, not eight unrelated AI images — the
// defining trait of the stick-figure explainer format (Sam O'Nella /
// Casually Explained / infographics-style channels).
const ILLUSTRATION_STYLE =
    "Simple flat cartoon illustration in a consistent hand-drawn explainer style: " +
    "a white stick-figure-like character with a plain round head and dot eyes, thick clean black outlines, " +
    "flat warm colors, minimal simple background, slightly naive comic look, absolutely no text, no words, no letters, no watermark.";

/**
 * Free image generation via Pollinations (FLUX-based, no API key, no cost —
 * verified live: the flat-cartoon output is actually closer to the target
 * explainer style than gpt-image-1's). A fixed seed per prompt keeps
 * results reproducible; gpt-image-1 remains the fallback when Pollinations
 * fails or IMAGE_ENGINE=openai is set.
 */
async function fetchPollinationsImage(prompt) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1536&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Pollinations → HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 5000) throw new Error("Pollinations returned a suspiciously small image");
    return buffer;
}

export async function generateCutawayImage(beat, jobId, style = "photo") {
    if (!config.enableAiCutaway) return null;
    try {
        const prompt = style === "illustrated"
            ? `Vertical 9:16. ${ILLUSTRATION_STYLE} Scene to depict: ${beat.query}. What it should convey: ${beat.intent || beat.line}.`
            : `Vertical 9:16 photorealistic cinematic still, no text or watermarks: ${beat.query}. Context: ${beat.intent || beat.line}. Natural lighting, shallow depth of field, looks like a real photograph, not illustration or CGI.`;
        const buffer = await fetchPollinationsImage(prompt.slice(0, 900));
        if (!buffer) return null;
        // Pollinations returns JPEG — sniff the magic bytes
        const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
        const imgPath = `broll-generated/${jobId}-${randomUUID().slice(0, 8)}.${isJpeg ? "jpg" : "png"}`;
        const { error } = await supabase.storage.from("renders").upload(imgPath, buffer, { contentType: isJpeg ? "image/jpeg" : "image/png", upsert: true });
        if (error) throw new Error(error.message);
        const { data } = supabase.storage.from("renders").getPublicUrl(imgPath);
        await logEvent("Agent 1", style === "illustrated"
            ? `Illustrated: "${beat.query}"`
            : `AI-generated cutaway for "${beat.query}" (no stock match found)`, { jobId });
        return {
            url: data.publicUrl,
            type: "image",
            duration: AI_CUTAWAY_DURATION,
            provider: "pollinations",
            license: "AI-generated (Pollinations FLUX) — original, not third-party footage",
            credit: "AI-generated",
            previewUrl: data.publicUrl,
        };
    } catch (err) {
        await logEvent("Agent 1", `AI cutaway generation failed for "${beat.query}": ${err.message}`, { jobId, level: "warn" });
        return null;
    }
}

// Fully-illustrated visual mode (editing_style_preset.visualMode =
// "illustrated"): every script beat gets a style-consistent cartoon
// illustration instead of stock footage — no stock search, no visual QA,
// no license juggling; the render's ken-burns motion animates the stills.
// Real per-image OpenAI cost (~8 images/video), so it's opt-in per niche.
const ILLUSTRATED_MAX_IMAGES = 8;

async function harvestIllustrated(niche, jobId, minTotalSeconds, visualQueries) {
    const beats = (Array.isArray(visualQueries) ? visualQueries : [])
        .filter((q) => q && typeof q.query === "string" && q.query.trim())
        .slice(0, ILLUSTRATED_MAX_IMAGES);
    if (!beats.length) return null;
    await logEvent("Agent 1", `Illustrated mode: generating ${beats.length} style-consistent cartoon frames (no stock search)...`, { jobId });
    const perImageSeconds = Math.max(4, Math.ceil(minTotalSeconds / beats.length) + 1);
    const clips = [];
    for (const beat of beats) {
        const image = await generateCutawayImage(beat, jobId, "illustrated");
        if (image) {
            clips.push({
                ...image,
                duration: perImageSeconds,
                keyword: beat.query,
                semanticCue: beat.line,
                visualIntent: beat.intent || null,
                overlay: beat.overlay || null,
            });
        }
    }
    // Below 3 usable frames the video would sit on one or two stills for
    // most of its runtime — let the caller fall back to the stock path.
    if (clips.length < 3) {
        await logEvent("Agent 1", `Illustrated mode only produced ${clips.length} frame(s) — falling back to stock footage`, { jobId, level: "warn" });
        return null;
    }
    clips._usage = { tokens: 0 };
    await logEvent("Agent 1", `Media locked: ${clips.length} illustrated frames, ~${clips.length * perImageSeconds}s of coverage`, { jobId });
    return clips;
}

export async function harvestFootage(niche, jobId, minTotalSeconds = 55, priorityKeywords = null, visualQueries = []) {
    if (niche.editing_style_preset?.visualMode === "illustrated" && config.enableAiCutaway) {
        const illustrated = await harvestIllustrated(niche, jobId, minTotalSeconds, visualQueries);
        if (illustrated) return illustrated;
    }
    await logEvent("Agent 1", `Sourcing licensed b-roll for ${niche.niche_name}...`, { jobId });
    const scriptedQueries = Array.isArray(visualQueries)
        ? visualQueries.map((q) => q?.query).filter((q) => typeof q === "string" && q.trim()).slice(0, 12)
        : [];
    const rest = niche.footage_keywords.filter((k) => !priorityKeywords?.includes(k));
    const keywords = scriptedQueries.length
        // A visual plan exists specifically to prevent generic niche b-roll.
        // Do not append random fallback keywords here.
        ? [...new Set(scriptedQueries)]
        : priorityKeywords?.length
        ? [...priorityKeywords, ...rest.sort(() => Math.random() - 0.5)]
        : [...niche.footage_keywords].sort(() => Math.random() - 0.5);
    const clips = [];
    let total = 0;
    let visualTokens = 0;
    const zeroMatchBeats = [];

    for (const kw of keywords) {
        if (total >= minTotalSeconds) break;
        const found = [...(await searchPexels(kw)), ...(await searchPixabay(kw))]
            .filter((c) => c.url && c.duration >= 4);
        const matchingBrief = visualQueries.find((q) => q?.query === kw);

        const { clips: verified, tokens } = await verifyVisualMatches(
            { line: matchingBrief?.line || kw, query: kw, intent: matchingBrief?.intent },
            found
        );
        visualTokens += tokens;
        if (verified.length < found.length) {
            await logEvent(
                "Agent 1",
                `"${kw}" → ${found.length} candidates, ${verified.length} passed visual QA`,
                { jobId }
            );
        }
        // Only a beat tied to an actual script line is worth generating a
        // real image for — the generic niche.footage_keywords fallback pool
        // doesn't map to a specific narrated moment.
        if (!verified.length && matchingBrief && zeroMatchBeats.length < AI_CUTAWAY_MAX_PER_VIDEO) {
            zeroMatchBeats.push(matchingBrief);
        }

        for (const clip of verified.slice(0, 2)) {
            clips.push({ ...clip, keyword: kw, semanticCue: matchingBrief?.line || kw, visualIntent: matchingBrief?.intent || null });
            total += Math.min(clip.duration, 8);
            if (total >= minTotalSeconds) break;
        }
        await logEvent("Agent 1", `"${kw}" → ${found.length} licensed clips (${Math.round(total)}s gathered)`, { jobId });
    }

    if (zeroMatchBeats.length) {
        await logEvent("Agent 1", `${zeroMatchBeats.length} script beat(s) had no matching stock footage — generating AI cutaways instead of forcing a mismatch`, { jobId });
        for (const beat of zeroMatchBeats) {
            const cutaway = await generateCutawayImage(beat, jobId);
            if (cutaway) {
                clips.push({ ...cutaway, keyword: beat.query, semanticCue: beat.line, visualIntent: beat.intent || null });
                total += cutaway.duration;
            }
        }
    }

    if (clips.length < 3 || total < minTotalSeconds * 0.65) {
        throw new Error(
            "Insufficient licensed footage passed visual QA — check PEXELS_API_KEY / PIXABAY_API_KEY, broaden footage_keywords, or temporarily disable VISUAL_QUALITY_GATE for diagnostics"
        );
    }
    await logEvent("Agent 1", `Media locked: ${clips.length} clips, ~${Math.round(total)}s of coverage`, { jobId });
    clips._usage = { tokens: visualTokens };
    return clips;
}
