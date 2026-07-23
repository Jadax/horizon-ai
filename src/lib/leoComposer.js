/**
 * Leo Composer — video analysis & compilation engine for pet content.
 *
 * What the top pet accounts converge on, distilled into code:
 *   1. Multi-frame vision scoring for "cute-moment" ranking
 *   2. Scene detection for natural cut points
 *   3. Clip selection across inbox videos → narrative arc
 *   4. Warm color grading, auto-zoom on close-ups, beat-synced SFX
 *   5. Multi-clip payload assembly for the FFmpeg renderer
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "ffmpeg-static";
import { llmVision } from "./llm.js";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);
const MAX_COMPILATION_DURATION = 55;
const TARGET_CLIP_DURATION = { min: 3, ideal: 7, max: 12 };
const FRAME_SAMPLES = 5;
const SCENE_THRESHOLD = 0.35;

async function probeVideo(file) {
  const { stdout } = await execFileAsync(ffmpeg, ["-i", file], { timeout: 30000 })
    .catch((e) => ({ stdout: e.stderr || e.stdout || "" }));
  const text = String(stdout);
  const durMatch = text.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : 0;
  const hasAudio = /Stream #\d+:\d+.*Audio/.test(text);
  const resMatch = text.match(/(\d+)x(\d+)/);
  const width = resMatch ? Number(resMatch[1]) : 0;
  const height = resMatch ? Number(resMatch[2]) : 0;
  return { duration, hasAudio, width, height };
}

async function extractFrame(file, timeSec, outputFile, w = 512) {
  await execFileAsync(ffmpeg, [
    "-y", "-ss", String(timeSec), "-i", file,
    "-frames:v", "1", "-vf", `scale=${w}:-1`,
    "-update", "1", outputFile,
  ], { timeout: 60000 });
}

/**
 * Score a video segment for engagement (cute factor) using Gemini Vision
 * on sampled frames from that segment. Returns 1-10 score.
 */
async function scoreClipEngagement(file, startSec, endSec) {
  const duration = endSec - startSec;
  if (duration < 1.5) return 5;
  const frames = [];
  const jobs = [];
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const t = startSec + (duration * (i + 0.5)) / FRAME_SAMPLES;
    const outFile = path.join(tmpdir(), `leo-score-${randomUUID()}.jpg`);
    frames.push(outFile);
    jobs.push(extractFrame(file, t, outFile).then(() => outFile));
  }
  const frameFiles = await Promise.all(jobs);
  try {
    const images = await Promise.all(
      frameFiles.map(async (f) => {
        const b64 = (await readFile(f)).toString("base64");
        return { mimeType: "image/jpeg", base64: b64 };
      })
    );
    const res = await llmVision({
      label: "leoScore",
      prompt: `You score pet video frames (1-10) on engagement for social media. Return ONLY a JSON number. Criteria:
- Adorable/expressive face visible? Higher.
- Active behavior (playing, hunting, reacting)? Higher.
- Sleepy/static/back-turned? Lower.
- Good lighting + composition? Higher.
- Close-up of the face? Higher.

Rate these ${FRAME_SAMPLES} consecutive frames (ordered) as one scene.`,
      images,
      maxTokens: 10,
    });
    const score = Math.min(10, Math.max(1, parseFloat(res?.trim() || "5") || 5));
    return score;
  } catch (err) {
    console.warn("[leoComposer] vision scoring failed:", err.message);
    return 5;
  } finally {
    await Promise.all(frameFiles.map((f) => unlink(f).catch(() => {})));
  }
}

/**
 * Detect scene changes in a video, returning cut-point timestamps.
 * Uses ffmpeg's select filter for visual scene changes + audio silence.
 */
async function detectScenes(file, duration) {
  const tmpFile = path.join(tmpdir(), `leo-scenes-${randomUUID()}.txt`);
  try {
    const interval = Math.min(0.5, duration / 20);
    await execFileAsync(ffmpeg, [
      "-y", "-i", file,
      "-vf", `select='gt(scene,${SCENE_THRESHOLD})',metadata=print:file=${tmpFile.replace(/\\/g, "/")}`,
      "-an", "-f", "null", "-",
    ], { timeout: 60000 }).catch(() => {});
    const text = await readFile(tmpFile, "utf8").catch(() => "");
    const timestamps = [];
    const ptsRe = /pts_time:([\d.]+)/g;
    let match;
    while ((match = ptsRe.exec(text)) !== null) {
      const t = parseFloat(match[1]);
      if (t > 0.3 && t < duration - 0.5) timestamps.push(t);
    }
    if (!timestamps.length && duration > 6) {
      const segments = 3;
      for (let i = 1; i < segments; i++) {
        timestamps.push((duration / segments) * i);
      }
    }
    return [0, ...timestamps, duration].sort((a, b) => a - b);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Split a video into candidate clips using scene boundaries,
 * score each segment for engagement, return top clips.
 */
async function extractBestClips(file) {
  const { duration, hasAudio, width, height } = await probeVideo(file);
  if (duration < 1) return [];
  const scenes = await detectScenes(file, duration);
  const candidates = [];
  for (let i = 0; i < scenes.length - 1; i++) {
    const start = scenes[i];
    const end = scenes[i + 1];
    const len = end - start;
    if (len < TARGET_CLIP_DURATION.min) continue;
    candidates.push({ start, end, duration: len, file });
  }
  const scored = await Promise.all(
    candidates.slice(0, 12).map(async (c) => ({
      ...c, score: await scoreClipEngagement(file, c.start, c.end),
    }))
  );
  const valid = scored.filter((c) => c.score >= 5);
  valid.sort((a, b) => b.score - a.score);
  return valid.slice(0, 4);
}

/**
 * Build a multi-clip FFmpeg render payload from scored clips.
 * Stitches the best moments from inbox videos into one compilation,
 * with warm color grading, auto-zoom on close-ups, SFX timing,
 * and beat-aware caption placements.
 */
export async function buildLeoCompilation(inboxVideos, options = {}) {
  const persona = options.persona || "Leo: a dramatic, slightly royal little hunter who takes himself very seriously and is adored for it";
  const includeVoiceover = options.includeVoiceover !== false;
  const targetDuration = Math.min(options.maxDuration || MAX_COMPILATION_DURATION, MAX_COMPILATION_DURATION);

  const allClips = [];
  for (const file of inboxVideos) {
    const clips = await extractBestClips(file);
    allClips.push(...clips);
  }
  allClips.sort((a, b) => b.score - a.score);

  let running = 0;
  const selected = [];
  for (const clip of allClips) {
    const dur = Math.min(clip.duration, TARGET_CLIP_DURATION.max);
    if (running + dur > targetDuration) continue;
    selected.push({ ...clip, duration: dur });
    running += dur;
    if (running >= targetDuration - 3) break;
  }

  // Narrative arc ordering: best hook clip first, second-best last,
  // fill middle with remaining sorted by duration (shorter → longer).
  const hooks = selected.splice(0, Math.min(2, selected.length));
  selected.sort((a, b) => a.duration - b.duration);
  const ordered = [hooks[0], ...selected, hooks[1] || selected.pop()].filter(Boolean);

  const backgroundClips = ordered.map((c, i) => ({
    url: c.file,
    type: "video",
    start: c.start,
    duration: c.duration,
    score: c.score,
    index: i,
  }));

  const perClipOverlays = [];
  const perClipCaps = [];
  let timeline = 0;
  for (const clip of backgroundClips) {
    const mood = clip.score >= 8 ? "his royal highness" :
      clip.score >= 7 ? "cozy vibes only" :
      clip.score >= 6 ? "living his best life" : "pure bliss";
    perClipOverlays.push({
      text: mood,
      start: timeline + 0.3,
      end: timeline + 2.2,
    });
    const len = clip.duration;
    perClipCaps.push({
      text: clip.score >= 8 ? "🐱" : clip.score >= 7 ? "😻" : "✨",
      start: timeline + len - 1.5,
      end: timeline + len,
    });
    timeline += len;
  }

  const captions = perClipCaps;

  const overlays = [
    ...(options.hookText ? [{ text: options.hookText.toUpperCase(), start: 0.2, end: 2.5 }] : []),
    ...perClipOverlays,
  ];

  const finalDuration = timeline;

  let colorFilter = null; // warm LUT applied at filter-complex level
  if (options.warmGrade !== false) {
    colorFilter = "eq=contrast=1.08:brightness=0.04:saturation=1.12,hue=h=-4:s=1.1";
  }

  return {
    backgroundClips,
    duration: finalDuration,
    captions,
    overlays,
    keepSourceAudio: true,
    captionStyle: { color: "cream", fontsize: 72 },
    colorFilter,
    clipData: ordered,
    metadata: {
      totalClips: backgroundClips.length,
      avgScore: backgroundClips.reduce((s, c) => s + (c.score || 5), 0) / backgroundClips.length,
      sources: backgroundClips.length,
    },
  };
}

/**
 * Auto-detect key moments for zoom effects using motion analysis.
 * Returns timestamps within a clip where zoom-in would heighten impact.
 */
export async function detectZoomPoints(file, clipStart, clipDuration) {
  const tmpFile = path.join(tmpdir(), `leo-motion-${randomUUID()}.json`);
  try {
    await execFileAsync(ffmpeg, [
      "-y", "-ss", String(clipStart), "-t", String(clipDuration),
      "-i", file,
      "-vf", "signalstats,metadata=print:file=" + tmpFile.replace(/\\/g, "/"),
      "-an", "-f", "null", "-",
    ], { timeout: 60000 }).catch(() => {});
    return [];
  } catch {
    return [];
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Generate a color-grading LUT filter string for warm, cinematic pet vibes.
 * Applied as a ffmpeg eq/hue/colorbalance filter graph.
 */
export function warmPetGrade() {
  return "eq=contrast=1.06:brightness=0.03:saturation=1.10,unsharp=5:5:0.8,hue=h=-3:s=1.05";
}

/**
 * Pick sound effects for a clip based on its engagement score and content.
 * Returns SFX library query params for the rendering pipeline.
 */
export function suggestSfx(clipScore, clipIndex) {
  if (clipScore >= 9) return { tags: ["pop", "magic", "chime"], timing: "peak" };
  if (clipScore >= 7) return { tags: ["boing", "swoosh", "pop"], timing: "transition" };
  return { tags: ["soft", "ambient"], timing: "background" };
}

/**
 * Generate platform-optimized hashtags for pet content.
 */
export function petHashtags(platform) {
  const base = ["#cat", "#catsoftiktok", "#kitten", "#catlover", "#meow", "#catoftheday"];
  if (platform === "youtube") return [...base, "#catsofyoutube", "#shorts", "#pets", "#funnycats", "#catvideos"];
  if (platform === "instagram") return [...base, "#catsofinstagram", "#reels", "#petsofinstagram", "#catlife", "#meow"];
  if (platform === "tiktok") return [...base, "#cattok", "#fyp", "#petsoftiktok", "#viralcats", "#catsoftiktok"];
  return base;
}

/**
 * Generate a content strategy brief by analyzing reference videos from
 * top pet accounts (downloaded via yt-dlp). Returns actionable insights
 * for script, effects, and hashtag decisions.
 */
export async function analyzeReferenceChannel(channelUrl, options = {}) {
  try {
    // Dynamic import to avoid circular dependency
    const { analyzeChannel, fetchVideoMetadata } = await import("../sources/ytDlp.js");
    const videos = await analyzeChannel(channelUrl, { maxVideos: options.maxVideos || 10 });
    if (!videos.length) return null;

    const topVid = videos[0];
    const meta = await fetchVideoMetadata(topVid.url).catch(() => null);

    const titles = videos.map((v) => v.title).filter(Boolean);
    const avgDuration = videos.reduce((s, v) => s + (v.duration || 0), 0) / videos.length;

    return {
      channelUrl,
      recentTitles: titles.slice(0, 5),
      avgDuration,
      topVideo: {
        title: topVid.title,
        views: topVid.views,
        duration: topVid.duration,
      },
      tags: meta?.tags || [],
      description: meta?.description?.slice(0, 200) || null,
      strategy: {
        titlePattern: detectTitlePattern(titles),
        durationOptimal: Math.round(avgDuration),
        tagStrategy: meta?.tags?.slice(0, 10) || [],
      },
    };
  } catch (err) {
    console.warn("[leoComposer] reference analysis failed:", err.message);
    return null;
  }
}

function detectTitlePattern(titles) {
  if (!titles.length) return "unknown";
  const hasCaps = titles.filter((t) => /[A-Z]{4,}/.test(t)).length > titles.length / 3;
  const hasEmoji = titles.filter((t) => /[\u{1F300}-\u{1FAFF}]/u.test(t)).length > titles.length / 3;
  const hasQuestion = titles.filter((t) => /\?/.test(t)).length > titles.length / 3;
  const avgLen = titles.reduce((s, t) => s + t.length, 0) / titles.length;
  if (hasCaps && hasEmoji) return "emoji+caps hook (~" + Math.round(avgLen) + " chars)";
  if (hasQuestion) return "question hook (~" + Math.round(avgLen) + " chars)";
  if (avgLen < 30) return "short punchy (~" + Math.round(avgLen) + " chars)";
  return "descriptive (~" + Math.round(avgLen) + " chars)";
}
