/**
 * VIDEOINTEL API — Universal video metadata & download
 * 
 * Uses Apify's VideoIntel actor to extract metadata and download links
 * from 1,500+ platforms including YouTube, TikTok, Instagram, Reddit,
 * Twitter/X, Vimeo, Twitch, Kick, Dailymotion, and more.
 * 
 * This is the COMPLIANT solution for scraping video content from across
 * the web without writing fragile, ToS-violating scrapers for each platform.
 */
import { config } from "../config.js";

const APIFY_API_BASE = "https://api.apify.com/v2";

/**
 * Fetches video metadata and download URL from a platform URL
 * 
 * @param {string} url - The URL of the video page (e.g., Reddit post, YouTube video, Tweet)
 * @param {object} options - Optional parameters
 * @param {string} options.download - Set to "true" to get a download link for the video
 * @param {string} options.downloadFormat - "mp4", "webm", or "best"
 * @param {number} options.timeout - Max seconds to wait for the actor to run
 * @returns {Promise<object>} - Video metadata including download URL
 */
export async function fetchVideoMetadata(url, options = {}) {
    if (!config.apifyApiKey) {
        throw new Error("APIFY_API_KEY is required for video metadata fetch");
    }

    const defaultOptions = {
        download: true,
        downloadFormat: "mp4",
        timeout: 60,
        ...options,
    };

    try {
        const input = {
            urls: [url],
            download: defaultOptions.download,
            downloadFormat: defaultOptions.downloadFormat,
            timeout: defaultOptions.timeout,
            extractComments: false,
            extractTranscript: false,
        };

        const runResponse = await fetch(
            `${APIFY_API_BASE}/acts/${config.apifyActorId}/runs`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${config.apifyApiKey}`,
                },
                body: JSON.stringify({ input }),
            }
        );

        if (!runResponse.ok) {
            const errorText = await runResponse.text();
            throw new Error(`VideoIntel API error: ${runResponse.status} ${errorText}`);
        }

        const runData = await runResponse.json();
        const runId = runData.data.id;

        let attempts = 0;
        const maxAttempts = Math.ceil(defaultOptions.timeout / 2);
        
        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 2000));

            const statusResponse = await fetch(
                `${APIFY_API_BASE}/acts/${config.apifyActorId}/runs/${runId}`,
                {
                    headers: {
                        "Authorization": `Bearer ${config.apifyApiKey}`,
                    },
                }
            );

            if (!statusResponse.ok) {
                throw new Error(`Failed to check actor status: ${statusResponse.status}`);
            }

            const statusData = await statusResponse.json();
            const status = statusData.data.status;

            if (status === "SUCCEEDED") {
                const resultResponse = await fetch(
                    `${APIFY_API_BASE}/acts/${config.apifyActorId}/runs/${runId}/dataset/items`,
                    {
                        headers: {
                            "Authorization": `Bearer ${config.apifyApiKey}`,
                        },
                    }
                );

                if (!resultResponse.ok) {
                    throw new Error(`Failed to fetch results: ${resultResponse.status}`);
                }

                const results = await resultResponse.json();
                if (!results || results.length === 0) {
                    return null;
                }

                const firstResult = results[0];
                
                return {
                    title: firstResult.title || firstResult.headline || "Untitled video",
                    url: firstResult.url || url,
                    duration: firstResult.duration || firstResult.length || 0,
                    views: firstResult.views || firstResult.viewCount || 0,
                    likes: firstResult.likes || firstResult.likeCount || 0,
                    comments: firstResult.comments || firstResult.commentCount || 0,
                    uploader: firstResult.uploader || firstResult.author || "Unknown",
                    platform: firstResult.platform || detectPlatform(url),
                    thumbnailUrl: firstResult.thumbnailUrl || firstResult.thumbnail || null,
                    downloadUrl: firstResult.downloadUrl || firstResult.download || null,
                    raw: firstResult,
                };
            } else if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
                throw new Error(`Actor run ${status}: ${statusData.data.errorMessage || "Unknown error"}`);
            }

            attempts++;
        }

        throw new Error(`VideoIntel actor timed out after ${defaultOptions.timeout} seconds`);
    } catch (error) {
        console.error("[videoIntel] Error:", error.message);
        throw error;
    }
}

/**
 * Detects the platform from a URL
 */
function detectPlatform(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (hostname.includes('youtube') || hostname.includes('youtu.be')) return 'youtube';
        if (hostname.includes('tiktok')) return 'tiktok';
        if (hostname.includes('instagram')) return 'instagram';
        if (hostname.includes('facebook') || hostname.includes('fb.')) return 'facebook';
        if (hostname.includes('twitter') || hostname.includes('x.com')) return 'twitter';
        if (hostname.includes('reddit')) return 'reddit';
        if (hostname.includes('vimeo')) return 'vimeo';
        if (hostname.includes('twitch')) return 'twitch';
        if (hostname.includes('kick')) return 'kick';
        if (hostname.includes('dailymotion')) return 'dailymotion';
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Batch fetch multiple videos at once
 */
export async function batchFetchVideoMetadata(urls, options = {}) {
    if (!config.apifyApiKey) {
        throw new Error("APIFY_API_KEY is required for batch video metadata fetch");
    }

    const defaultOptions = {
        download: true,
        downloadFormat: "mp4",
        timeout: 120,
        ...options,
    };

    try {
        const input = {
            urls: urls,
            download: defaultOptions.download,
            downloadFormat: defaultOptions.downloadFormat,
            timeout: defaultOptions.timeout,
        };

        const runResponse = await fetch(
            `${APIFY_API_BASE}/acts/${config.apifyActorId}/runs`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${config.apifyApiKey}`,
                },
                body: JSON.stringify({ input }),
            }
        );

        if (!runResponse.ok) {
            throw new Error(`VideoIntel batch API error: ${runResponse.status}`);
        }

        const runData = await runResponse.json();
        const runId = runData.data.id;

        let attempts = 0;
        const maxAttempts = Math.ceil(defaultOptions.timeout / 2);

        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 2000));

            const statusResponse = await fetch(
                `${APIFY_API_BASE}/acts/${config.apifyActorId}/runs/${runId}`,
                {
                    headers: { "Authorization": `Bearer ${config.apifyApiKey}` },
                }
            );

            if (!statusResponse.ok) continue;

            const statusData = await statusResponse.json();
            const status = statusData.data.status;

            if (status === "SUCCEEDED") {
                const resultResponse = await fetch(
                    `${APIFY_API_BASE}/acts/${config.apifyActorId}/runs/${runId}/dataset/items`,
                    {
                        headers: { "Authorization": `Bearer ${config.apifyApiKey}` },
                    }
                );

                if (!resultResponse.ok) {
                    throw new Error(`Failed to fetch batch results: ${resultResponse.status}`);
                }

                const results = await resultResponse.json();
                return results.map(item => ({
                    title: item.title || item.headline || "Untitled video",
                    url: item.url || "unknown",
                    duration: item.duration || item.length || 0,
                    views: item.views || item.viewCount || 0,
                    likes: item.likes || item.likeCount || 0,
                    comments: item.comments || item.commentCount || 0,
                    uploader: item.uploader || item.author || "Unknown",
                    platform: item.platform || detectPlatform(item.url || ""),
                    thumbnailUrl: item.thumbnailUrl || item.thumbnail || null,
                    downloadUrl: item.downloadUrl || item.download || null,
                }));
            } else if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
                throw new Error(`Batch actor run ${status}: ${statusData.data.errorMessage || "Unknown error"}`);
            }

            attempts++;
        }

        throw new Error(`Batch actor timed out after ${defaultOptions.timeout} seconds`);
    } catch (error) {
        console.error("[videoIntel] Batch error:", error.message);
        throw error;
    }
}