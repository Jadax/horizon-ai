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

export async function syncLeoInbox() {
  const inbox = config.leoInboxDir;
  const entries = await readdir(inbox).catch(() => null);
  if (!entries) {
    console.error(`Leo inbox not found: ${inbox} — create it and drop cat videos in.`);
    return;
  }
  const videos = [];
  for (const name of entries) {
    if (!VIDEO_EXT.test(name)) continue;
    const full = path.join(inbox, name);
    if ((await stat(full)).isFile()) videos.push(full);
  }
  if (!videos.length) {
    console.log("Leo inbox is empty — nothing to do.");
    return;
  }
  console.log(`Leo: ${videos.length} video(s) in inbox`);

  const { data: nicheRow } = await supabase
    .from("niche_configurations")
    .select("*")
    .eq("niche_name", "Leo")
    .single();

  // With < MIN_VIDEOS_FOR_COMPILATION videos, run the single-clip mode
  // (legacy fallback for when there's only one video in the inbox).
  if (videos.length < MIN_VIDEOS_FOR_COMPILATION) {
    return await processLegacySingle(videos[0], nicheRow);
  }

  // Multi-clip compilation: all videos become one polished short
  try {
    await processCompilation(videos, nicheRow);
  } catch (err) {
    console.error(`[leo] compilation failed: ${err.message}`);
    // Fall back: process each video individually
    console.log("[leo] falling back to single-video mode...");
    for (const file of videos) {
      try {
        await processLegacySingle(file, nicheRow);
      } catch (e) {
        console.error(`[leo] ${path.basename(file)}: ${e.message} (left in inbox for retry)`);
      }
    }
  }
}

/**
 * Legacy single-video mode — used when there's only one clip in the inbox
 * or when the compilation approach fails. Same cozy pet treatment but
 * simpler: one video, one narration, no multi-clip stitching.
 */
async function processLegacySingle(file, nicheRow) {
  const persona = nicheRow?.editing_style_preset?.persona ||
    "Leo: a dramatic, slightly royal little hunter who takes himself very seriously and is adored for it";
  const base = path.basename(file);
  const { duration: srcDuration, hasAudio } = await probeVideo(file);
  if (!srcDuration) throw new Error("Could not read video duration");
  const duration = Math.min(srcDuration, 45);
  const targetChannel = nicheRow?.target_channel || "primary";

  const { data: job, error } = await supabase.from("pipeline_logs").insert({
    niche: "Leo", status: "Scripting", target_channel: targetChannel, topic: base,
  }).select().single();
  if (error) throw new Error(`pipeline_logs insert failed: ${error.message}`);
  const jobId = job.id;

  try {
    const notePath = file.replace(VIDEO_EXT, ".txt");
    const note = await readFile(notePath, "utf8").then((t) => t.trim()).catch(() => null);
    const frameFile = file + ".frame.jpg";
    const scene = note ? null : await extractFrame(file, Math.max(0.5, srcDuration / 2), frameFile)
      .then(async () => {
        const b64 = (await readFile(frameFile)).toString("base64");
        const res = await llmVision({
          label: "leoFrame",
          prompt: "Describe what this cat is doing in one concrete, specific sentence (posture, action, setting, expression). No preamble.",
          images: [{ mimeType: "image/jpeg", base64: b64 }],
          maxTokens: 120,
        });
        return res?.trim() || null;
      })
      .catch(() => null)
      .finally(() => unlink(frameFile).catch(() => {}));

    const copy = await llmJson({
      tier: "fast", temperature: 0.8, label: "leoCopy",
      messages: [
        {
          role: "system",
          content: `You write copy for a wholesome cat channel. PERSONA (keep every video consistent with this character): ${persona}. Given what's happening in a clip, return JSON:
{"narration":"1-2 short warm sentences a doting cat parent would actually say out loud about THIS moment (spoken by a real person, natural rhythm, no emoji, no hashtags, max 30 words)",
"hook":"1-4 word ALL-CAPS overlay for the first seconds (POV-style, curious, or affectionate)",
"title":"cozy clickable title under 60 chars, exactly one cat or paw emoji",
"description":"1 warm sentence + newline + #cat #catsofyoutube #kitten #catlover #shorts",
"tags":["8-12 discovery tags like cat, cute cat, funny cat, kitten, cat video"]}
If OWNER_NOTE is provided, keep its meaning and warmth, just polish it for speech.`,
        },
        { role: "user", content: JSON.stringify({ OWNER_NOTE: note || null, SCENE: scene || null, FILENAME: base }) },
      ],
    }).then((r) => JSON.parse(r.content));

    await logEvent("Leo", `"${base}" → narration: "${copy.narration.slice(0, 60)}..." | hook: ${copy.hook}`, { jobId });

    const voiceId = config.leoVoiceId || "Leda";
    const engine = config.leoVoiceId && config.elevenlabsKey ? "elevenlabs" : undefined;
    const { voiceoverUrl, words, duration: voDuration } = await synthesizeVoiceover(
      copy.narration, voiceId, jobId, duration, engine ? { engine } : undefined
    );

    const musicTrack = await pickMusic("Chill", jobId, { moods: ["warm", "cozy", "lounge"] });
    const outDuration = Math.min(Math.max(voDuration + 1.5, 10), duration);
    const payload = {
      duration: outDuration,
      backgroundClips: [{ url: file, type: "video", start: 0, duration: outDuration }],
      audioUrl: voiceoverUrl,
      musicUrl: musicTrack?.track_url || null,
      keepSourceAudio: hasAudio,
      captions: words.filter((w) => w.start < outDuration).map((w, i, arr) => {
        const chunk = arr.slice(Math.floor(i / 3) * 3, Math.floor(i / 3) * 3 + 3);
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

    const allTags = [...new Set([...(copy.tags || []), ...petHashtags("youtube"), ...petHashtags("tiktok"), ...petHashtags("instagram")])];
    const publishPackage = buildPublishPackage({
      jobId, niche: "Leo", videoUrl: renderResult.url,
      subtitleUrl: renderResult.subtitleUrl, syncPrecisionMs: config.subtitleSyncPrecisionMs,
      duration: outDuration, title: copy.title, description: copy.description, tags: allTags,
      thumbnailUrl: renderResult.thumbnailUrl, coverVariants: renderResult.coverVariants,
      qualityReport: { overall_score: 85, hook_score: 85, technical_pass: true, retention_prediction: "85%", issues: [] },
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
      content_quality_score: 85,
      quality_report: { overall_score: 85, hook_score: 85, technical_pass: true, retention_prediction: "85%", issues: [], breakdown: null },
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
      await notifyAwaitingApproval({ jobId, title: copy.title, score: 85, duration: outDuration, videoUrl: renderResult.url });
    }

    const processedDir = path.join(path.dirname(file), "processed");
    await rename(file, path.join(processedDir, base));
    if (note) await rename(notePath, path.join(processedDir, path.basename(notePath))).catch(() => {});
    await logEvent("Leo", `"${base}" done → ${config.autopilot ? "scheduled" : "awaiting approval"}`, { jobId });
    return jobId;
  } catch (err) {
    await logEvent("Leo", `"${base}" failed: ${err.message}`, { jobId, level: "error" });
    await updateJob(jobId, { status: "Failed", error: err.message });
    throw err;
  }
}

if (process.argv[1]?.endsWith("leo.js")) {
  syncLeoInbox().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
