/**
 * AGENT 1 — THE UNIVERSAL TREND & VIDEO HARVESTER
 * 
 * Sources content from across the web using metadata and video downloads.
 */
import { config } from "../config.js";
import OpenAI from "openai";
import { supabase, logEvent } from "../supabase.js";
import { batchFetchVideoMetadata } from "../sources/videoIntel.js";
import { scoreVideoForVirality, quickVideoFilter } from "../lib/viralScoring.js";
import { fetchRSSFeed } from "../sources/rss.js";
import { fetchSocialRSSFeeds, normaliseSocialFeeds } from "../sources/socialRss.js";
import { fetchGoogleTrends, fetchGoogleNews } from "../sources/googleTrends.js";
import { fetchGDELT } from "../sources/gdelt.js";
import { fetchYouTubeTrending } from "../sources/youtubeTrending.js";
import { fetchMastodonHashtag, fetchLemmyHot } from "../sources/fediverse.js";
import { fetchTopReddit, searchWiki } from "../sources/reddit.js";
import { rankCandidates, recalibrateWeights } from "../lib/trendScoring.js";

const openai = new OpenAI({ apiKey: config.openaiKey });

async function harvestSocialVideos(niche, jobId, limit = 15) {
    const videos = [];
    
    // 1. Reddit: find high-scoring posts with video URLs
    for (const source of niche.target_sources || []) {
        if (!source.startsWith('r/')) continue;
        try {
            const posts = await fetchTopReddit(source, 15);
            for (const post of posts) {
                if (post.url && !post.url.includes('reddit.com') && 
                    (post.url.includes('youtube.com') || post.url.includes('tiktok.com') || 
                     post.url.includes('instagram.com') || post.url.includes('twitter.com') ||
                     post.url.includes('vimeo.com') || post.url.includes('dailymotion.com'))) {
                    
                    if (post.score > 50 || post.num_comments > 20) {
                        videos.push({
                            title: post.title,
                            url: post.url,
                            source: `Reddit (${source})`,
                            pubDate: post.pubDate,
                            score: post.score,
                            num_comments: post.num_comments,
                            selftext: post.selftext,
                        });
                    }
                }
            }
            await logEvent("Agent 1", `Reddit ${source}: ${videos.length} video candidates found`, { jobId });
        } catch (err) {
            await logEvent("Agent 1", `Reddit ${source} failed: ${err.message}`, { jobId, level: "warn" });
        }
    }

    // 2. YouTube Trending
    try {
        const ytTrending = await fetchYouTubeTrending(niche.trend_region || "US", 10);
        for (const item of ytTrending) {
            videos.push({
                title: item.title,
                url: `https://youtube.com/watch?v=${item.id}`,
                source: "YouTube Trending",
                pubDate: item.pubDate,
            });
        }
    } catch (err) {
        await logEvent("Agent 1", `YouTube Trending fetch failed: ${err.message}`, { jobId, level: "warn" });
    }

    // 3. Fetch metadata for all video URLs
    const videoMetadata = [];
    const urlsToFetch = videos.map(v => v.url).slice(0, 10);
    
    if (urlsToFetch.length > 0 && config.apifyApiKey) {
        try {
            const metadataResults = await batchFetchVideoMetadata(urlsToFetch, { download: true });
            for (const result of metadataResults) {
                const original = videos.find(v => v.url === result.url || v.url.includes(result.url?.split('?')[0]));
                videoMetadata.push({
                    ...original,
                    ...result,
                    reddit_score: original?.score,
                    reddit_comments: original?.num_comments,
                });
            }
            await logEvent("Agent 1", `Fetched metadata for ${videoMetadata.length} videos`, { jobId });
        } catch (err) {
            await logEvent("Agent 1", `Batch metadata fetch failed: ${err.message}`, { jobId, level: "warn" });
        }
    } else {
        videoMetadata.push(...videos);
    }

    // 4. Score each video for viral potential
    const scoredVideos = [];
    for (const video of videoMetadata) {
        try {
            const filterResult = quickVideoFilter(video, 5, 180);
            if (!filterResult.passed) {
                await logEvent("Agent 1", `Filtered out: ${filterResult.reason}`, { jobId, level: "debug" });
                continue;
            }

            const scores = await scoreVideoForVirality(video, niche.niche_name);
            
            const threshold = config.qualityScoreThreshold || 7.0;
            if (scores.overall >= threshold) {
                scoredVideos.push({
                    ...video,
                    _viralScore: scores.overall,
                    _scoreBreakdown: scores.breakdown,
                    _reasoning: scores.reasoning,
                    _usage: scores._usage,
                    _type: "video",
                });
                await logEvent("Agent 1", `✅ Video scored ${scores.overall.toFixed(1)}/10: "${video.title.slice(0, 60)}..."`, { jobId });
            } else {
                await logEvent("Agent 1", `⏭️ Video scored ${scores.overall.toFixed(1)}/10 (below threshold)`, { jobId, level: "debug" });
            }
        } catch (err) {
            await logEvent("Agent 1", `Scoring failed for video: ${err.message}`, { jobId, level: "warn" });
        }
    }

    scoredVideos.sort((a, b) => (b._viralScore || 0) - (a._viralScore || 0));
    return scoredVideos.slice(0, 5);
}

export async function harvestAllCandidates(niche, jobId = null) {
    const log = (msg, level) => (jobId ? logEvent("Agent 1", msg, { jobId, level }) : logEvent("Agent 1", msg, { level }));
    await log(`Scanning sources for ${niche.niche_name}...`);

    const candidates = [];
    const tag = (items, source) => items.map((i) => ({ ...i, source }));

    // 1. SOCIAL VIDEOS (NEW)
    const socialVideos = await harvestSocialVideos(niche, jobId);
    candidates.push(...socialVideos);

    // 2. RSS feeds
    for (const feedUrl of niche.rss_feeds || []) {
        try {
            const items = await fetchRSSFeed(feedUrl);
            candidates.push(...tag(items, new URL(feedUrl).hostname));
            await log(`RSS ${new URL(feedUrl).hostname}: ${items.length} candidates`);
        } catch (err) {
            await log(`RSS feed failed (${feedUrl}): ${err.message}`, "warn");
        }
    }

    // 3. Social RSS feeds
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

    // 4. Google Trends
    try {
        const trends = await fetchGoogleTrends(niche.trend_region || "US");
        candidates.push(...tag(trends, "Google Trends"));
        await log(`Google Trends: ${trends.length} candidates`);
    } catch (err) {
        await log(`Google Trends fetch failed: ${err.message}`, "warn");
    }

    // 5. YouTube Trending
    try {
        const ytTrending = await fetchYouTubeTrending(niche.trend_region || "US", 8);
        candidates.push(...tag(ytTrending, "YouTube Trending"));
        if (ytTrending.length) await log(`YouTube Trending: ${ytTrending.length} candidates`);
    } catch (err) {
        await log(`YouTube Trending fetch failed: ${err.message}`, "warn");
    }

    // 6. Fediverse
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

    // 7. News niche specific sources
    if (niche.niche_name === "News") {
        try {