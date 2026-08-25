/**
 * YT-DLP wrapper — video metadata & download from 1,800+ platforms
 * including YouTube, TikTok, Instagram, Twitter/X, Reddit, Twitch, Kick,
 * Facebook, Vimeo, Dailymotion, and more.
 *
 * Uses the system yt-dlp binary (installed via pip: `pip install yt-dlp`,
 * and included in the Dockerfile for Cloud Run).
 * Metadata discovery is available for public search results. Download
 * functions are used only for operator-owned or explicitly licensed sources
 * (Agent 6 clipper, per CLAUDE.md's SCRAPE POLICY); the platform's own
 * export remains preferred when available.
 *
 * Pruned in 3.16.0: downloadVideo/downloadAudioOnly/getDirectUrl/
 * batchFetchVideoMetadata/analyzeChannel had zero callers (the Leo reference-
 * channel analyzer that used analyzeChannel was removed with the dead v2
 * compilation path). Recover from git history if ever needed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);
const YTDLP = config.ytDlpPath || "yt-dlp";

async function runYtDlp(args, options = {}) {
  return execFileAsync(YTDLP, args, { windowsHide: true, ...options });
}

// yt-dlp --dump-json prints one JSON object PER LINE (search/playlist URLs
// emit several). Naive JSON.parse on the whole stdout blows up with
// "Unexpected non-whitespace character after JSON". Split per line.
function parseDumpJson(stdout) {
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export async function fetchVideoMetadata(url, options = {}) {
  const timeout = options.timeout || 30000;
  const maxBuffer = 10 * 1024 * 1024;
  const { stdout } = await runYtDlp(["--dump-json", "--no-download", "--quiet", String(url)], { timeout, maxBuffer }).catch((e) => {
    throw new Error(`yt-dlp metadata fetch failed: ${e.stderr || e.message}`);
  });
  const entries = parseDumpJson(stdout);
  if (!entries.length) throw new Error("yt-dlp metadata fetch returned no entries");
  const data = entries[0];
  return {
    title: data.title || "Untitled video",
    url: data.webpage_url || url,
    duration: data.duration || 0,
    views: data.view_count || 0,
    likes: data.like_count || 0,
    comments: data.comment_count || 0,
    uploader: data.uploader || data.channel || "Unknown",
    uploaderId: data.uploader_id || data.channel_id || null,
    platform: data.extractor_key || detectPlatform(url),
    thumbnailUrl: data.thumbnail || null,
    description: data.description || null,
    tags: data.tags || [],
    categories: data.categories || [],
    uploadDate: data.upload_date || null,
    raw: data,
  };
}

export async function downloadBestVideo(url, options = {}) {
  const timeout = options.timeout || 120000;
  const maxDuration = options.maxDuration || null;
  const outFile = path.join(tmpdir(), `horizon-dl-${randomUUID()}.mp4`);
  try {
    const args = [
      '-f', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best',
      '-o', outFile,
      '--merge-output-format', 'mp4',
      '--no-playlist',
    ];
    if (maxDuration) args.push('--match-filter', `duration <= ${maxDuration}`);
    args.push(String(url));
    await runYtDlp(args, { timeout, maxBuffer: 50 * 1024 * 1024 });
    const buffer = await readFile(outFile);
    const metadata = await fetchVideoMetadata(url).catch(() => null);
    await unlink(outFile).catch(() => {});
    return { buffer, filename: path.basename(outFile), metadata };
  } catch (error) {
    await unlink(outFile).catch(() => {});
    throw new Error(`yt-dlp best-video download failed: ${error.stderr || error.message}`);
  }
}

export async function searchVideos(query, options = {}) {
  const maxResults = options.maxResults || 10;
  const source = options.source || "ytsearch";
  const searchUrl = `${source}${maxResults}:${query}`;
  try {
    const timeout = options.timeout || 60000;
    const { stdout } = await runYtDlp(["--dump-json", "--no-download", "--quiet", searchUrl], { timeout, maxBuffer: 20 * 1024 * 1024 });
    return parseDumpJson(stdout).map((d) => ({
      title: d.title || "Untitled video",
      url: d.webpage_url || d.original_url || d.url || searchUrl,
      duration: d.duration || 0,
      views: d.view_count || 0,
      likes: d.like_count || 0,
      comments: d.comment_count || 0,
      uploader: d.uploader || d.channel || "Unknown",
      uploaderId: d.uploader_id || d.channel_id || null,
      platform: d.extractor_key || "search",
      thumbnailUrl: d.thumbnail || null,
      description: d.description || null,
      tags: d.tags || [],
      uploadDate: d.upload_date || null,
      raw: d,
    }));
  } catch {
    return [];
  }
}

function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("youtube") || hostname.includes("youtu.be")) return "youtube";
    if (hostname.includes("tiktok")) return "tiktok";
    if (hostname.includes("instagram")) return "instagram";
    if (hostname.includes("facebook") || hostname.includes("fb.")) return "facebook";
    if (hostname.includes("twitter") || hostname.includes("x.com")) return "twitter";
    if (hostname.includes("reddit")) return "reddit";
    if (hostname.includes("vimeo")) return "vimeo";
    if (hostname.includes("twitch")) return "twitch";
    if (hostname.includes("kick")) return "kick";
    if (hostname.includes("dailymotion")) return "dailymotion";
    return "unknown";
  } catch {
    return "unknown";
  }
}
