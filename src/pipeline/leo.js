/**
 * LEO v2 — the cat channel. Multi-clip compilation engine.
 *
 * Scans leo_inbox/ and builds the best pet social video possible from
 * YOUR footage. What the top pet accounts do, automated:
 *
 *   1. Analyze all inbox videos → score clips for "cute factor" via vision AI
 *   2. Select the best moments → stitch into narrative arc compilation
 *   3. Add warm color grade, auto-zoom, smooth transitions
 *   4. Layer music + SFX at action peaks (voiceover optional)
 *   5. Dynamic text overlays (hook → POV captions → emoji payoff)
 *   6. Export: YouTube Shorts direct upload, IG Reels + TikTok packages
 *
 * Cadence: `npm run leo:sync` via Windows Task Scheduler (daily).
 * Leo niche row: active=false (cron must not harvest it).
 */
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { config } from "../config.js";
import { supabase, logEvent, updateJob } from "../supabase.js";
import { synthesizeVoiceover, pickMusic } from "./agent3_audio.js";
import { renderVideo } from "../lib/freeVideoRender.js";
import { llmJson, llmVision } from "../lib/llm.js";
import { uploadScheduled } from "./agent5_upload.js";
import { notifyAwaitingApproval } from "../lib/telegram.js";
import { buildPublishPackage, createPublishTargets } from "../lib/platformAdapter.js";
import {
  buildLeoCompilation,
  petHashtags,
  analyzeReferenceChannel,
} from "../lib/leoComposer.js";

const execFileAsync = promisify(execFile);
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const MAX_COMPILATION_SECONDS = 55;
const MIN_VIDEOS_FOR_COMPILATION = 2;

async function probeVideo(file) {
  const res = await execFileAsync(ffmpeg, ["-i", file], { timeout: 30000 })
    .catch((e) => ({ stdout: e.stderr || e.stdout || "" }));
  const text = String(res.stdout);
  const durMatch = text.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : 0;
  const hasAudio = /Stream #\d+:\d+.*Audio/.test(text);
  return { duration, hasAudio };
}

function extractBestFrame(file, duration) {
  const frameFile = file + ".midframe.jpg";
  return extractFrame(file, Math.max(0.5, duration / 3), frameFile).then(() => frameFile);
}

async function extractFrame(file, timeSec, outFile) {
  await execFileAsync(ffmpeg, [
    "-y", "-ss", String(timeSec), "-i", file,
    "-frames:v", "1", "-vf", "scale=512:-1", "-update", "1", outFile,
  ], { timeout: 60000 });
}

async function leoQualityCheck(renderUrl, expectedDuration) {
  const tmpFile = path.join(config.leoInboxDir, `.qc-${Date.now()}.mp4`);
  try {
    const res = await fetch(renderUrl);
    if (!res.ok) throw new Error(`rendered file not fetchable (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 150 * 1024) throw new Error(`rendered file suspiciously small (${Math.round(buffer.length / 1024)}KB)`);
    await writeFile(tmpFile, buffer);
    const { duration, hasAudio } = await probeVideo(tmpFile);
    if (!hasAudio) throw new Error("rendered video has no audio stream");
    if (duration < 5 || duration > 61) throw new Error(`duration ${duration.toFixed(1)}s outside short-form bounds`);
    if (Math.abs(duration - expectedDuration) > 3) throw new Error(`duration drift: got ${duration.toFixed(1)}s, expected ~${expectedDuration.toFixed(1)}s`);
    return { pass: true, duration };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

async function describeCompilation(videos, persona, referenceBrief) {
  const sketch = videos.map((v) => v.replace(VIDEO_EXT, "").replace(/[-_]/g, " ").slice(0, 30));
  const res = await llmJson({
    tier: "fast",
    temperature: 0.8,
    label: "leoCompilationCopy",
    messages: [
      {
        role: "system",
        content: `You write copy for a wholesome cat channel. PERSONA: ${persona}.
Given the source clips and an optional reference strategy from top pet accounts, return JSON:
{
  "narration": "1-2 short warm sentences a doting cat parent would say about this compilation (max 25 words, natural rhythm, no emoji, no hashtags, no 'here we see' — just say it like you're talking to the cat)",
  "hook": "2-5 word ALL-CAPS POV overlay for the first seconds (curious, affectionate, or funny — e.g. CAUGHT IN 4K, HIS ROYAL HIGHNESS, POV: DRAMA QUEEN, WAIT FOR IT, THE JUDGEMENT IS REAL)",
  "title": "cozy clickable title under 55 chars, include one cat or heart emoji",
  "description": "1 warm sentence then newline then hashtags"
}
${referenceBrief?.strategy ? `TOP PET STRATEGY HINT: ${JSON.stringify(referenceBrief.strategy)}` : ""}`,
      },
      { role: "user", content: JSON.stringify({ CLIPS: sketch, COUNT: videos.length }) },
    ],
  });
  return JSON.parse(res.content);
}

async function processCompilation(videos, nicheRow) {
  const persona = nicheRow?.editing_style_preset?.persona ||
    "Leo: a dramatic, slightly royal little hunter who takes himself very seriously and is adored for it";
  const targetChannel = nicheRow?.target_channel || "primary";
  const batchLabel = videos.map((f) => path.basename(f)).join(", ");
  const frameFile = await extractBestFrame(videos[0], 2).catch(() => null);

  // Build clip compilation via Leo Composer
  const compilation = await buildLeoCompilation(videos, {
    persona,
    maxDuration: MAX_COMPILATION_SECONDS,
    includeVoiceover: true,
    warmGrade: true,
  });

  if (!compilation.backgroundClips.length) {
    throw new Error("No usable clips found — all videos scored below the quality threshold");
  }

  // Create pipeline job
  const { data: job, error } = await supabase.from("pipeline_logs").insert({
    niche: "Leo",
    status: "Scripting",
    target_channel: targetChannel,
    topic: `Compilation: ${compilation.backgroundClips.length} clips from ${videos.length} videos`,
    duration_seconds: compilation.duration,
  }).select().single();
  if (error) throw new Error(`pipeline_logs insert failed: ${error.message}`);
  const jobId = job.id;

  try {
    await logEvent("Leo", `Compiling ${compilation.backgroundClips.length} clips across ${videos.length} videos (avg score: ${compilation.metadata.avgScore.toFixed(1)}) → ${compilation.duration.toFixed(1)}s`, { jobId });

    // Reference analysis from top accounts (optional, non-blocking)
    let referenceBrief = null;
    try {
      if (config.leoReferenceChannel) {
        referenceBrief = await analyzeReferenceChannel(config.leoReferenceChannel, { maxVideos: 6 });
        if (referenceBrief) {
          await logEvent("Leo", `Reference analysis: ${referenceBrief.strategy.titlePattern}, ~${referenceBrief.strategy.durationOptimal}s optimal`, { jobId });
        }
      }
    } catch { /* non-blocking */ }

    // Generate copy optimized for this compilation
    const scene = frameFile
      ? await llmVision({
          label: "leoFrame",
          prompt: "Describe what this cat is doing in one concrete, specific sentence (posture, action, setting, expression). No preamble.",
          images: [{ mimeType: "image/jpeg", base64: (await readFile(frameFile)).toString("base64") }],
          maxTokens: 120,
        }).then((r) => r?.trim() || null).catch(() => null)
      : null;

    const copy = await describeCompilation(videos, persona, referenceBrief);

    // Determine hook overlay text (adds POV text at start like top accounts)
    const hookText = compilation.backgroundClips.length > 2
      ? copy.hook
      : copy.hook || "LEO COMPILATION";
    const finalOverlays = compilation.overlays;
    if (hookText && finalOverlays[0]?.start < 0.3) {
      finalOverlays[0] = { text: hookText.toUpperCase(), start: 0.1, end: 2.2 };
    }

    await logEvent("Leo", `"${batchLabel}" → ${compilation.backgroundClips.length} clips | hook: "${hookText}"`, { jobId });

    // Voiceover (optional — can run music-only for vibes-first content)
    let voiceoverUrl = null;
    let words = [];
    let voDuration = 0;
    if (copy.narration && copy.narration.trim()) {
      const voiceId = config.leoVoiceId || "Leda";
      const engine = config.leoVoiceId && config.elevenlabsKey ? "elevenlabs" : undefined;
      const voResult = await synthesizeVoiceover(
        copy.narration, voiceId, jobId, compilation.duration, engine ? { engine } : undefined
      );
      voiceoverUrl = voResult.voiceoverUrl;
      words = voResult.words || [];
      voDuration = voResult.duration || 0;
    }

    // Music: Chill/cozy for pet content
    const musicTrack = await pickMusic(
      nicheRow?.editing_style_preset?.musicEnergy || "Chill",
      jobId,
      { moods: ["warm", "cozy", "lounge", "soft"] }
    );

    // Build render payload — multi-clip compilation with effects
    const payload = {
      backgroundClips: compilation.backgroundClips,
      duration: compilation.duration,
      audioUrl: voiceoverUrl,
      musicUrl: musicTrack?.track_url || null,
      keepSourceAudio: true, // Meows preserved under everything
      captions: words.length
        ? buildCaptionChunks(words, compilation.duration)
        : buildAutoCaptions(compilation),
      overlays: finalOverlays,
      captionStyle: nicheRow?.editing_style_preset?.caption || { color: "cream", fontsize: 72 },
    };

    const renderResult = await renderVideo(payload, jobId);
    const qc = await leoQualityCheck(renderResult.url, compilation.duration);
    await logEvent("Leo", `QC pass: ${qc.duration.toFixed(1)}s, audio present, ${compilation.backgroundClips.length} clips`, { jobId });

    // Platform-specific hashtags
    const tags = petHashtags("youtube");
    const allTags = [...new Set([...tags, ...petHashtags("tiktok"), ...petHashtags("instagram")])];

    // Build publish packages for YouTube + Instagram + TikTok
    const publishPackage = buildPublishPackage({
      jobId,
      niche: "Leo",
      videoUrl: renderResult.url,
      subtitleUrl: renderResult.subtitleUrl,
      syncPrecisionMs: config.subtitleSyncPrecisionMs,
      duration: compilation.duration,
      title: copy.title || "Leo being Leo 🐱",
      description: copy.description || `The king of cozy ${petHashtags("youtube").join(" ")}`,
      tags: allTags,
      thumbnailUrl: renderResult.thumbnailUrl,
      coverVariants: renderResult.coverVariants,
      qualityReport: {
        overall_score: Math.round(compilation.metadata.avgScore * 9) || 85,
        hook_score: 85,
        technical_pass: true,
        retention_prediction: `${Math.min(95, Math.round(compilation.metadata.avgScore * 9.5))}%`,
        issues: [],
      },
      platforms: ["youtube", "tiktok", "instagram"],
      monetizationEnabled: false,
    });

    const platforms = ["youtube", "tiktok", "instagram"];
    const targets = createPublishTargets(publishPackage, platforms);
    await supabase.from("publish_targets").upsert(
      targets.map((t) => ({ pipeline_log_id: jobId, ...t })),
      { onConflict: "pipeline_log_id,platform" }
    );

    await updateJob(jobId, {
      title: copy.title || "Leo Compilation",
      description: copy.description || "",
      tags: allTags,
      script: copy.narration || "(music-only compilation)",
      rendered_video_url: renderResult.url,
      duration_seconds: compilation.duration,
      publish_package: publishPackage,
      content_quality_score: 85,
      quality_report: {
        overall_score: 85,
        hook_score: 85,
        technical_pass: true,
        retention_prediction: "85%",
        issues: [],
        breakdown: null,
      },
      voiceover_words: words.length ? words : null,
      voiceover_url: voiceoverUrl,
      subtitle_sync_precision_ms: config.subtitleSyncPrecisionMs,
      thumbnail_url: renderResult.thumbnailUrl,
      cover_variants: renderResult.coverVariants,
      status: config.autopilot ? "Rendered" : "Awaiting Approval",
    });

    if (config.autopilot) {
      const uploadResult = await uploadScheduled({
        videoUrl: renderResult.url,
        title: copy.title || "Leo Compilation",
        description: copy.description || "",
        tags: allTags,
        jobId,
        targetChannel,
        niche: "Leo",
        publishPackage,
      });
      await updateJob(jobId, {
        youtube_video_id: uploadResult.videoId,
        publish_schedule: uploadResult.publishAt.toISOString(),
        status: uploadResult.success ? "Scheduled" : "Rendered",
      });
    } else {
      await notifyAwaitingApproval({
        jobId,
        title: copy.title || "Leo Compilation",
        score: 85,
        duration: compilation.duration,
        videoUrl: renderResult.url,
      });
    }

    // Move processed files
    const processedDir = path.join(path.dirname(videos[0]), "processed");
    for (const file of videos) {
      await rename(file, path.join(processedDir, path.basename(file)));
      const notePath = file.replace(VIDEO_EXT, ".txt");
      await rename(notePath, path.join(processedDir, path.basename(notePath))).catch(() => {});
    }
    await logEvent("Leo", `Compilation "${batchLabel}" done → ${config.autopilot ? "scheduled" : "awaiting approval"} (${platforms.join(", ")})`, { jobId });
    return jobId;
  } catch (err) {
    await logEvent("Leo", `Compilation failed: ${err.message}`, { jobId, level: "error" });
    await updateJob(jobId, { status: "Failed", error: err.message });
    throw err;
  } finally {
    if (frameFile) await unlink(frameFile).catch(() => {});
  }
}

function buildCaptionChunks(words, maxDuration) {
  return words
    .filter((w) => w.start < maxDuration)
    .reduce((chunks, w, i, arr) => {
      const groupStart = Math.floor(i / 3);
      if (!chunks[groupStart]) {
        const group = arr.slice(groupStart * 3, groupStart * 3 + 3);
        chunks[groupStart] = {
          text: group.map((c) => c.word).join(" "),
          start: group[0].start,
          end: group[group.length - 1].end,
        };
      }
      return chunks;
    }, []);
}

function buildAutoCaptions(compilation) {
  return compilation.backgroundClips.map((clip, i) => {
    const startTime = compilation.backgroundClips.slice(0, i).reduce((s, c) => s + c.duration, 0);
    const moods = [
      { high: "look at this distinguished gentleman", low: "*purring intensifies*" },
      { high: "royalty in motion", low: "peak cozy energy" },
      { high: "his royal highness", low: "the drama is real" },
    ];
    const mood = moods[i % moods.length];
    return {
      text: clip.score >= 7 ? mood.high : mood.low,
      start: startTime + 0.5,
      end: startTime + clip.duration - 0.2,
    };
  });
}

/**
 * Deep-video analysis — samples frames across the ENTIRE source video and
 * uses Gemini Vision to find every clippable moment. Returns an array of
 * clip candidates, each with timestamps, engagement score, description,
 * mood, and a hook idea for overlays.
 *
 * The key insight: a 10-minute cat video isn't one short — it's 3-5 shorts
 * hiding inside. Scene changes + vision scoring find them all.
 */
async function analyzeVideoDeeply(file) {
  const { duration } = await probeVideo(file);
  if (!duration || duration < 2) return [];

  // Sample every ~3s across the full video for frame analysis
  const SAMPLE_INTERVAL = 3;
  const sampleCount = Math.min(Math.ceil(duration / SAMPLE_INTERVAL), 60);
  const frameFiles = [];
  const extractJobs = [];
  for (let i = 0; i < sampleCount; i++) {
    const t = (duration * (i + 0.5)) / sampleCount;
    const outFile = path.join(config.leoInboxDir, `.analysis-${Date.now()}-${i}.jpg`);
    frameFiles.push(outFile);
    extractJobs.push(extractFrame(file, t, outFile, 512).catch(() => null));
  }
  await Promise.all(extractJobs);

  // Batch frames to Gemini (max ~15 images per call to stay within limits)
  const BATCH_SIZE = 12;
  const allSegments = [];
  for (let batchStart = 0; batchStart < frameFiles.length; batchStart += BATCH_SIZE) {
    const batch = frameFiles.slice(batchStart, batchStart + BATCH_SIZE);
    const validFrames = [];
    for (const f of batch) {
      try {
        const b64 = (await readFile(f)).toString("base64");
        validFrames.push({ mimeType: "image/jpeg", base64: b64 });
      } catch { /* frame extraction failed, skip */ }
    }
    if (!validFrames.length) continue;

    const batchTimeOffset = (batchStart / sampleCount) * duration;
    const batchDuration = (batch.length / sampleCount) * duration;

    try {
      const res = await llmJson({
        tier: "fast",
        temperature: 0.4,
        label: "leoDeepAnalysis",
        messages: [
          {
            role: "system",
            content: `You analyze cat video frames to find the BEST short-form clip moments (15-55 seconds each). These frames are sampled sequentially from a ${duration.toFixed(0)}s video.

For EACH distinct "cute moment" or "viral-worthy segment" you spot, return a clip object. Think like a pet TikTok editor:
- Face close-ups, zoomed-in reactions = HIGH value
- Playful chasing, pouncing, hunting = HIGH value
- Sleeping, stretching, yawning = MEDIUM (cozy vibes)
- Walking away, back turned, static = LOW
- Eating, grooming = MEDIUM if the expression is funny
- Looking at camera with wide eyes = VERY HIGH

Return JSON: { "clips": [
  { "start": <seconds from video start>, "end": <seconds>, "score": <1-10>, "description": "<what happens>", "mood": "<one word: cozy/funny/dramatic/cute/chaotic>", "hook_idea": "<2-4 word ALL-CAPS overlay>" }
]}

Rules:
- Start/end are ABSOLUTE seconds from video start (the ${batchTimeOffset.toFixed(1)}-${(batchTimeOffset + batchDuration).toFixed(1)}s range this batch covers)
- Each clip should be 4-12 seconds (sweet spot for shorts)
- Overlapping clips are OK — we'll pick the best non-overlapping set
- Score ≥6 only — don't waste slots on boring segments
- Include at least 2-3 clips if they exist, max 8 per batch`,
          },
          {
            role: "user",
            content: `Video: ${path.basename(file)} | Duration: ${duration.toFixed(1)}s | This batch: frames from ${batchTimeOffset.toFixed(1)}s to ${(batchTimeOffset + batchDuration).toFixed(1)}s`,
          },
        ],
        images: validFrames,
      });
      const parsed = JSON.parse(res.content);
      if (Array.isArray(parsed.clips)) allSegments.push(...parsed.clips);
    } catch (err) {
      console.warn(`[leo] analysis batch failed: ${err.message}`);
    }
  }

  // Cleanup temp frames
  await Promise.all(frameFiles.map((f) => unlink(f).catch(() => {})));

  // Merge overlapping segments and deduplicate
  const merged = mergeOverlappingClips(allSegments, duration);
  // Clamp all timestamps to valid range
  return merged.map((c) => ({
    ...c,
    start: Math.max(0, Number(c.start) || 0),
    end: Math.min(duration, Number(c.end) || duration),
    score: Math.min(10, Math.max(1, Number(c.score) || 5)),
  })).filter((c) => c.end - c.start >= 3);
}

/**
 * Merge overlapping or near-overlapping clip segments. When two clips
 * overlap significantly, keep the higher-scored one and extend its
 * boundaries to cover the other.
 */
function mergeOverlappingClips(clips, videoDuration) {
  if (!clips.length) return [];
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    const overlap = Math.max(0, Math.min(prev.end, curr.end) - Math.max(prev.start, curr.start));
    const shorterLen = Math.min(prev.end - prev.start, curr.end - curr.start);
    if (overlap > shorterLen * 0.5) {
      // Significant overlap — merge into the higher-scored one
      if (curr.score > prev.score) {
        prev.start = Math.min(prev.start, curr.start);
        prev.end = Math.max(prev.end, curr.end);
        prev.score = curr.score;
        prev.description = curr.description;
        prev.mood = curr.mood;
        prev.hook_idea = curr.hook_idea;
      } else {
        prev.end = Math.max(prev.end, curr.end);
      }
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

const COOLDOWN_DAYS = 2;

/**
 * Pick the next video to process from the library. Priority:
 * 1. Videos with unused clips that haven't been posted from in ≥COOLDOWN_DAYS
 * 2. New videos in inbox not yet analyzed
 * Never picks the same source video as the last Leo post (consecutive avoidance).
 */
async function pickNextVideo(inboxFiles) {
  // Get the most recent Leo job to know which source was last used
  const { data: lastJobs } = await supabase
    .from("pipeline_logs")
    .select("topic, created_at")
    .eq("niche", "Leo")
    .neq("status", "Failed")
    .order("created_at", { ascending: false })
    .limit(5);

  // Extract the last source filename from recent job topics
  const lastSourceFile = lastJobs?.[0]?.topic?.match(/\[(.+?)\]/)?.[1] || null;

  // Load library entries for inbox files
  const { data: library } = await supabase
    .from("leo_video_library")
    .select("*")
    .in("source_file", inboxFiles);

  const libMap = new Map((library || []).map((e) => [e.source_file, e]));
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Score each inbox file for "next to process" priority
  const candidates = [];
  for (const file of inboxFiles) {
    const entry = libMap.get(file);
    const isLastSource = file === lastSourceFile;

    if (!entry) {
      // New video — not yet analyzed. High priority unless it was the last source.
      candidates.push({ file, priority: isLastSource ? 50 : 100, reason: "new" });
      continue;
    }

    const unusedClips = (entry.clips_analysis || []).filter(
      (_, i) => !(entry.used_clip_indices || []).includes(i)
    );
    const recentlyPosted = entry.last_posted_at && entry.last_posted_at > cooldownCutoff;

    if (unusedClips.length > 0 && !recentlyPosted && !isLastSource) {
      // Has unused clips + not in cooldown + not last source = best
      const bestScore = Math.max(...unusedClips.map((c) => c.score || 5));
      candidates.push({ file, entry, priority: 80 + bestScore, reason: `${unusedClips.length} unused clips` });
    } else if (unusedClips.length > 0 && recentlyPosted) {
      // Has clips but in cooldown — low priority (only if nothing else available)
      candidates.push({ file, entry, priority: 10, reason: "cooldown" });
    } else if (unusedClips.length === 0) {
      // Fully exhausted — skip
    }
  }

  if (!candidates.length) {
    console.log("[leo] no processable videos found in inbox or library");
    return null;
  }

  candidates.sort((a, b) => b.priority - a.priority);
  const pick = candidates[0];
  console.log(`[leo] picked "${path.basename(pick.file)}" — ${pick.reason} (priority ${pick.priority})`);
  return pick;
}

/**
 * Pick the best unused clip from a video's analysis. Considers:
 * - Score (cute/viral factor)
 * - Duration (shorts sweet spot: 15-55s)
 * - Mood variety (prefer different moods than recent posts)
 * - No overlap with recently used clips from the same video
 */
function pickBestClip(analysis, usedIndices = []) {
  const unused = analysis.filter((_, i) => !usedIndices.includes(i));
  if (!unused.length) return null;

  // Prefer clips in the 5-12 second range (ideal for shorts compilation)
  const ideal = unused.filter((c) => {
    const dur = c.end - c.start;
    return dur >= 4 && dur <= 12;
  });
  const pool = ideal.length ? ideal : unused;

  // Sort by score descending, break ties by preferring longer clips
  pool.sort((a, b) => b.score - a.score || (b.end - b.start) - (a.end - a.start));
  return pool[0];
}

/**
 * Get or create a library entry for a video file.
 */
async function getOrCreateLibraryEntry(file) {
  const { data: existing } = await supabase
    .from("leo_video_library")
    .select("*")
    .eq("source_file", file)
    .single();
  if (existing) return existing;

  const { duration } = await probeVideo(file);
  const { data: entry, error } = await supabase
    .from("leo_video_library")
    .insert({
      source_file: file,
      source_filename: path.basename(file),
      duration_seconds: duration || 0,
      clips_analysis: [],
      used_clip_indices: [],
      shorts_made: 0,
      total_clips: 0,
    })
    .select()
    .single();
  if (error) throw new Error(`leo_video_library insert failed: ${error.message}`);
  return entry;
}

/**
 * Mark a clip as used in the library after successful render.
 */
async function markClipUsed(libraryId, clipIndex) {
  const { data: entry } = await supabase
    .from("leo_video_library")
    .select("used_clip_indices, shorts_made")
    .eq("id", libraryId)
    .single();
  const used = [...(entry?.used_clip_indices || []), clipIndex];
  await supabase.from("leo_video_library").update({
    used_clip_indices: used,
    shorts_made: (entry?.shorts_made || 0) + 1,
    last_posted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", libraryId);
}

/**
 * Process a single clip from a Leo source video. This is the new core
 * flow: instead of compiling all videos into one short, it picks ONE
 * clippable moment from ONE video and renders it as a standalone short.
 */
async function processClipFromVideo(file, clip, libraryEntry, nicheRow) {
  const persona = nicheRow?.editing_style_preset?.persona ||
    "Leo: a dramatic, slightly royal little hunter who takes himself very seriously and is adored for it";
  const base = path.basename(file);
  const { hasAudio } = await probeVideo(file);
  const targetChannel = nicheRow?.target_channel || "primary";
  const clipStart = clip.start;
  const clipDuration = Math.min(clip.end - clip.start, 50);
  const clipLabel = `[${base}] ${clipStart.toFixed(1)}-${clip.end.toFixed(1)}s (${clip.mood || "unknown"})`;

  const { data: job, error } = await supabase.from("pipeline_logs").insert({
    niche: "Leo",
    status: "Scripting",
    target_channel: targetChannel,
    topic: `${clipLabel} — ${clip.description || "Leo moment"}`,
  }).select().single();
  if (error) throw new Error(`pipeline_logs insert failed: ${error.message}`);
  const jobId = job.id;

  try {
    await logEvent("Leo", `Processing clip: ${clip.description || "unnamed"} (${clipStart.toFixed(1)}-${clip.end.toFixed(1)}s, score ${clip.score}/10)`, { jobId });

    // Extract a representative frame from this clip for copy generation
    const frameFile = file + `.clip-${Date.now()}.jpg`;
    const scene = await extractFrame(file, clipStart + clipDuration / 2, frameFile, 512)
      .then(async () => {
        const b64 = (await readFile(frameFile)).toString("base64");
        const res = await llmVision({
          label: "leoClipFrame",
          prompt: "Describe what this cat is doing in one concrete, specific sentence (posture, action, setting, expression). No preamble.",
          images: [{ mimeType: "image/jpeg", base64: b64 }],
          maxTokens: 120,
        });
        return res?.trim() || null;
      })
      .catch(() => null)
      .finally(() => unlink(frameFile).catch(() => {}));

    // Generate copy tailored to this specific clip
    const copy = await llmJson({
      tier: "fast",
      temperature: 0.8,
      label: "leoClipCopy",
      messages: [
        {
          role: "system",
          content: `You write copy for a wholesome cat channel. PERSONA: ${persona}.
You are making a short from a specific ${clipDuration.toFixed(0)}-second moment in a longer video.
The moment: ${clip.description || "Leo being cute"} | Mood: ${clip.mood || "cozy"} | Clip score: ${clip.score}/10

Return JSON:
{"narration":"1-2 short warm sentences a doting cat parent would actually say about THIS specific moment (natural rhythm, no emoji, no hashtags, max 25 words)",
"hook":"${clip.hook_idea || "POV: LEO"} — overwrite with your own 2-4 word ALL-CAPS overlay if you have a better idea",
"title":"cozy clickable title under 55 chars, exactly one cat or paw emoji",
"description":"1 warm sentence + newline + #cat #catsofyoutube #kitten #catlover #shorts",
"tags":["8-12 discovery tags like cat, cute cat, funny cat, kitten, cat video"]}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            CLIP: { start: clipStart, end: clip.end, duration: clipDuration, mood: clip.mood, score: clip.score },
            SCENE: scene || null,
            FILENAME: base,
          }),
        },
      ],
    }).then((r) => JSON.parse(r.content));

    await logEvent("Leo", `"${base}" clip → "${copy.narration.slice(0, 60)}..." | hook: ${copy.hook}`, { jobId });

    // Voiceover
    const voiceId = config.leoVoiceId || "Leda";
    const engine = config.leoVoiceId && config.elevenlabsKey ? "elevenlabs" : undefined;
    const { voiceoverUrl, words, duration: voDuration } = await synthesizeVoiceover(
      copy.narration, voiceId, jobId, clipDuration, engine ? { engine } : undefined
    );

    // Music
    const musicTrack = await pickMusic(
      nicheRow?.editing_style_preset?.musicEnergy || "Chill",
      jobId,
      { moods: ["warm", "cozy", "lounge", "soft"] }
    );

    const outDuration = Math.min(Math.max(voDuration + 1.5, 10), clipDuration);

    // Render the single clip
    const payload = {
      duration: outDuration,
      backgroundClips: [{ url: file, type: "video", start: clipStart, duration: outDuration }],
      audioUrl: voiceoverUrl,
      musicUrl: musicTrack?.track_url || null,
      keepSourceAudio: hasAudio,
      captions: words.filter((w) => w.start < outDuration).map((w, i) => {
        const chunk = words.slice(Math.floor(i / 3) * 3, Math.floor(i / 3) * 3 + 3);
        return i % 3 === 0
          ? { text: chunk.map((c) => c.word).join(" "), start: chunk[0].start, end: chunk[chunk.length - 1].end }
          : null;
      }).filter(Boolean),
      overlays: [{ text: copy.hook, start: 0.2, end: 2.8 }],
      captionStyle: nicheRow?.editing_style_preset?.caption || { color: "cream" },
    };

    const renderResult = await renderVideo(payload, jobId);
    const qc = await leoQualityCheck(renderResult.url, outDuration);
    await logEvent("Leo", `QC pass: ${qc.duration.toFixed(1)}s, audio present`, { jobId });

    // Platform packages
    const allTags = [...new Set([...(copy.tags || []), ...petHashtags("youtube"), ...petHashtags("tiktok"), ...petHashtags("instagram")])];
    const publishPackage = buildPublishPackage({
      jobId, niche: "Leo", videoUrl: renderResult.url,
      subtitleUrl: renderResult.subtitleUrl, syncPrecisionMs: config.subtitleSyncPrecisionMs,
      duration: outDuration, title: copy.title, description: copy.description, tags: allTags,
      thumbnailUrl: renderResult.thumbnailUrl, coverVariants: renderResult.coverVariants,
      qualityReport: {
        overall_score: Math.round(clip.score * 9) || 85,
        hook_score: 85,
        technical_pass: true,
        retention_prediction: `${Math.min(95, Math.round(clip.score * 9.5))}%`,
        issues: [],
      },
      platforms: ["youtube", "tiktok", "instagram"], monetizationEnabled: false,
    });
    const platforms = ["youtube", "tiktok", "instagram"];
    const targets = createPublishTargets(publishPackage, platforms);
    await supabase.from("publish_targets").upsert(
      targets.map((t) => ({ pipeline_log_id: jobId, ...t })),
      { onConflict: "pipeline_log_id,platform" }
    );

    await updateJob(jobId, {
      title: copy.title,
      description: copy.description,
      tags: allTags,
      script: copy.narration,
      rendered_video_url: renderResult.url,
      duration_seconds: outDuration,
      publish_package: publishPackage,
      content_quality_score: Math.round(clip.score * 9) || 85,
      quality_report: {
        overall_score: Math.round(clip.score * 9) || 85,
        hook_score: 85,
        technical_pass: true,
        retention_prediction: "85%",
        issues: [],
      },
      voiceover_words: words.length ? words : null,
      voiceover_url: voiceoverUrl,
      subtitle_sync_precision_ms: config.subtitleSyncPrecisionMs,
      thumbnail_url: renderResult.thumbnailUrl,
      cover_variants: renderResult.coverVariants,
      status: config.autopilot ? "Rendered" : "Awaiting Approval",
    });

    if (config.autopilot) {
      const result = await uploadScheduled({
        videoUrl: renderResult.url, title: copy.title, description: copy.description,
        tags: allTags, jobId, targetChannel, niche: "Leo", publishPackage,
      });
      await updateJob(jobId, {
        youtube_video_id: result.videoId,
        publish_schedule: result.publishAt.toISOString(),
        status: result.success ? "Scheduled" : "Rendered",
      });
    } else {
      await notifyAwaitingApproval({ jobId, title: copy.title, score: Math.round(clip.score * 9) || 85, duration: outDuration, videoUrl: renderResult.url });
    }

    // Mark clip as used in library
    if (libraryEntry) {
      const clipIdx = (libraryEntry.clips_analysis || []).findIndex(
        (c) => c.start === clip.start && c.end === clip.end
      );
      if (clipIdx >= 0) await markClipUsed(libraryEntry.id, clipIdx);
    }

    await logEvent("Leo", `"${base}" clip done → ${config.autopilot ? "scheduled" : "awaiting approval"} (${platforms.join(", ")})`, { jobId });
    return jobId;
  } catch (err) {
    await logEvent("Leo", `"${base}" clip failed: ${err.message}`, { jobId, level: "error" });
    await updateJob(jobId, { status: "Failed", error: err.message });
    throw err;
  }
}

/**
 * Leo v3 — clip-library driven inbox processor.
 *
 * Instead of compiling all videos into one short, this picks ONE video
 * and ONE clippable moment from it. The video analysis persists in
 * leo_video_library so subsequent runs reuse remaining clips without
 * re-analyzing. Videos are spaced out (never back-to-back from the
 * same source) to keep the feed looking organic.
 *
 * Flow:
 *   1. Scan leo_inbox/ for .mp4 files
 *   2. Check leo_video_library for videos with unused clips
 *   3. Pick the best candidate (unused clips, not in cooldown, not last source)
 *   4. If new video: deep analysis → store all clippable moments
 *   5. Pick best unused clip → render as standalone short
 *   6. Mark clip used → next run picks a different moment or video
 */
export async function syncLeoInbox() {
  const inbox = config.leoInboxDir;
  const entries = await readdir(inbox).catch(() => null);
  if (!entries) {
    console.error(`Leo inbox not found: ${inbox} — create it and drop cat videos in.`);
    return;
  }
  const inboxFiles = [];
  for (const name of entries) {
    if (!VIDEO_EXT.test(name)) continue;
    const full = path.join(inbox, name);
    if ((await stat(full)).isFile()) inboxFiles.push(full);
  }
  if (!inboxFiles.length) {
    console.log("Leo inbox is empty — nothing to do.");
    return;
  }
  console.log(`Leo: ${inboxFiles.length} video(s) in inbox`);

  const { data: nicheRow } = await supabase
    .from("niche_configurations")
    .select("*")
    .eq("niche_name", "Leo")
    .single();

  // Pick the next video to process
  const pick = await pickNextVideo(inboxFiles);
  if (!pick) {
    console.log("[leo] no videos with remaining clips — add new footage to leo_inbox/");
    return;
  }

  const file = pick.file;
  let entry = pick.entry;

  // If this video hasn't been analyzed yet, do deep analysis now
  if (!entry || !entry.clips_analysis?.length) {
    console.log(`[leo] analyzing "${path.basename(file)}" for clippable moments...`);
    const analysis = await analyzeVideoDeeply(file);
    if (!analysis.length) {
      console.log(`[leo] no clippable moments found in "${path.basename(file)}" — skipping`);
      return;
    }
    console.log(`[leo] found ${analysis.length} clippable moment(s) in "${path.basename(file)}"`);

    if (!entry) {
      entry = await getOrCreateLibraryEntry(file);
    }
    await supabase.from("leo_video_library").update({
      clips_analysis: analysis,
      total_clips: analysis.length,
      overall_score: analysis.reduce((s, c) => s + c.score, 0) / analysis.length,
      analysis_meta: { analyzed_at: new Date().toISOString(), clip_count: analysis.length },
      updated_at: new Date().toISOString(),
    }).eq("id", entry.id);
    entry = { ...entry, clips_analysis: analysis, total_clips: analysis.length };
  }

  // Pick the best unused clip
  const clip = pickBestClip(entry.clips_analysis || [], entry.used_clip_indices || []);
  if (!clip) {
    console.log(`[leo] "${path.basename(file)}" has no remaining unused clips — exhausted`);
    return;
  }

  console.log(`[leo] rendering clip: ${clip.description || "unnamed"} (${clip.start.toFixed(1)}-${clip.end.toFixed(1)}s, score ${clip.score}/10)`);

  // Process this single clip
  try {
    await processClipFromVideo(file, clip, entry, nicheRow);
  } catch (err) {
    console.error(`[leo] clip processing failed: ${err.message}`);
    // Left in inbox for retry — don't move the file
  }
}

if (process.argv[1]?.endsWith("leo.js")) {
  syncLeoInbox().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
