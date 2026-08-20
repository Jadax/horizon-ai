/**
 * YT-DLP wrapper — video metadata & download from 1,800+ platforms
 * including YouTube, TikTok, Instagram, Twitter/X, Reddit, Twitch, Kick,
 * Facebook, Vimeo, Dailymotion, and more.
 *
 * Uses the system yt-dlp binary (installed via pip: `pip install yt-dlp`,
 * and included in the Dockerfile for Cloud Run).
 * Metadata discovery is available for public search results. Download
 * functions are used only for operator-owned or explicitly licensed sources;
 * the platform's own export remains preferred when available.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink } from "node:fs/promises";
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

export async function downloadVideo(url, options = {}) {
  const format = options.format || "mp4";
  const quality = options.quality || "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";
  const maxDuration = options.maxDuration || null;
  const outFile = path.join(tmpdir(), `horizon-dl-${randomUUID()}.%(ext)s`);
  try {
    const args = ["-f", quality];
    if (maxDuration) args.push("--match-filter", `duration <= ${maxDuration}`);
    args.push("-o", outFile, "--no-playlist", "--quiet", String(url));
    await runYtDlp(args, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
    const actualFile = outFile.replace("%(ext)s", format);
    const buffer = await readFile(actualFile);
    const metadata = await fetchVideoMetadata(url).catch(() => null);
    await unlink(actualFile).catch(() => {});
    return {
      buffer,
      filename: path.basename(actualFile),
      metadata,
    };
  } catch (error) {
    const actualFile = outFile.replace("%(ext)s", format);
    await unlink(actualFile).catch(() => {});
    throw new Error(`yt-dlp download failed: ${error.stderr || error.message}`);
  }
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

export async function downloadAudioOnly(url, options = {}) {
  const timeout = options.timeout || 120000;
  const outFile = path.join(tmpdir(), `horizon-dl-${randomUUID()}.mp3`);
  try {
    await runYtDlp([
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '-o', outFile,
      '--no-playlist', '--quiet', String(url),
    ], { timeout, maxBuffer: 10 * 1024 * 1024 });
    const buffer = await readFile(outFile);
    await unlink(outFile).catch(() => {});
    return { buffer, filename: path.basename(outFile) };
  } catch (error) {
    await unlink(outFile).catch(() => {});
    throw new Error(`yt-dlp audio download failed: ${error.stderr || error.message}`);
  }
}

export async function getDirectUrl(url, format = "best") {
  try {
    const { stdout } = await runYtDlp(['-g', '-f', String(format), String(url)], { timeout: 30000 });
    const lines = stdout.trim().split("\n");
    return lines[0] || null;
  } catch {
    return null;
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

export async function batchFetchVideoMetadata(urls, options = {}) {
  const results = [];
  for (const url of urls) {
    try {
      const meta = await fetchVideoMetadata(url, options);
      results.push(meta);
    } catch (error) {
      results.push({ url, error: error.message });
    }
  }
  return results;
}

export async function analyzeChannel(channelUrl, options = {}) {
  const maxVideos = options.maxVideos || 20;
  try {
    const args = [
      '--flat-playlist',
      '--dump-json',
      '--playlist-end', String(maxVideos),
      '--quiet',
      String(channelUrl),
    ];
    const { stdout } = await runYtDlp(args, { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      try {
        const data = JSON.parse(line);
        return {
          id: data.id || null,
          title: data.title || "Untitled",
          url: data.url || data.webpage_url || null,
          duration: data.duration || 0,
          views: data.view_count || 0,
          uploadDate: data.upload_date || null,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (error) {
    console.warn("[yt-dlp] Channel analysis failed:", error.message);
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
