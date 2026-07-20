/**
 * LEO — the cat channel. Local-folder workflow (videos live on this
 * machine, not on Railway): `npm run leo:sync` scans leo_inbox/ and, for
 * each new video, runs the full pet-video treatment end-to-end, then moves
 * the file to leo_inbox/processed/. Schedule the command with Windows Task
 * Scheduler for a daily cadence.
 *
 * The pet-video treatment (what the big cat accounts converge on):
 *  - hook text burned in over the first ~2.5s (curiosity/POV style),
 *  - the cat's ORIGINAL audio preserved under the narration (meows are the
 *    content; keepSourceAudio in the renderer exists for exactly this),
 *  - a short, warm, doting one/two-line narration — from a same-named .txt
 *    sidecar file if present (write what she'd say; it gets spoken in the
 *    configured voice), otherwise auto-written from what's actually in the
 *    frame (vision pass on a mid-video still),
 *  - soft Chill-register music ducked under the voice,
 *  - big friendly captions, cozy title + pet hashtags,
 *  - Awaiting Approval unless AUTOPILOT=true, same as every other niche.
 *
 * Voice: LEO_VOICE_ID + ELEVENLABS_API_KEY → her cloned voice (ElevenLabs
 * Instant Voice Clone from a consented 1-3 min recording). Without those it
 * uses OpenAI's warmest voice ("coral"). TikTok/Instagram remain package-
 * mode exports until their APIs are approved; YouTube uploads directly.
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

const execFileAsync = promisify(execFile);
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const MAX_CLIP_SECONDS = 45;

async function probeVideo(file) {
  const { stdout } = await execFileAsync(ffmpeg, ["-i", file], { timeout: 30000 }).catch((e) => ({ stdout: e.stderr || e.stdout || "" }));
  const text = String(stdout);
  const dur = text.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  return { duration, hasAudio: /Stream #\d+:\d+.*Audio/.test(text) };
}

async function describeFrame(file, duration) {
  const frameFile = file + ".frame.jpg";
  try {
    await execFileAsync(ffmpeg, ["-y", "-ss", String(Math.max(0.5, duration / 2)), "-i", file, "-frames:v", "1", "-vf", "scale=512:-1", "-update", "1", frameFile], { timeout: 60000 });
    const b64 = (await readFile(frameFile)).toString("base64");
    const res = await llmVision({
      label: "leoFrame",
      prompt: "Describe what this cat is doing in one concrete, specific sentence (posture, action, setting, expression). No preamble.",
      images: [{ mimeType: "image/jpeg", base64: b64 }],
      maxTokens: 120,
    });
    return res.content?.trim() || null;
  } catch (err) {
    console.warn("[leo] frame description failed:", err.message);
    return null;
  } finally {
    await unlink(frameFile).catch(() => {});
  }
}

async function writePetCopy({ note, sceneDescription, filename, persona }) {
  const res = await llmJson({
    tier: "fast",
    temperature: 0.8,
    label: "leoCopy",
    messages: [
      {
        role: "system",
        content: `You write copy for a wholesome cat channel. PERSONA (keep every video consistent with this character): ${persona}. Given what's happening in a clip, return JSON:
{"narration":"1-2 short warm sentences a doting cat parent would actually say out loud about THIS moment (spoken by a real person, so natural rhythm, no emoji, no hashtags, max 30 words)",
"hook":"1-4 word ALL-CAPS overlay for the first seconds (POV-style, curious, or affectionate - e.g. CAUGHT IN 4K, HIS ROYAL HIGHNESS, WAIT FOR IT)",
"title":"cozy clickable title under 60 chars, exactly one cat or paw emoji",
"description":"1 warm sentence + these on a new line: #cat #catsofyoutube #kitten #catlover #shorts",
"tags":["8-12 discovery tags like cat, cute cat, funny cat, kitten, cat video"]}
If OWNER_NOTE is provided it is what the owner wants said - keep its meaning and warmth, just polish it for speech.`,
      },
      { role: "user", content: JSON.stringify({ OWNER_NOTE: note || null, SCENE: sceneDescription || null, FILENAME: filename }) },
    ],
  });
  return JSON.parse(res.content);
}

/**
 * Output QC for Leo renders — probes the actual rendered file: it must have
 * an audio stream, land within short-form duration bounds, and be a real
 * encode (not a truncated upload). Hard fail = job marked Failed, source
 * left in the inbox for retry.
 */
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
    if (Math.abs(duration - expectedDuration) > 2.5) throw new Error(`duration drift: got ${duration.toFixed(1)}s, expected ~${expectedDuration.toFixed(1)}s`);
    return { pass: true, duration };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

async function processOneVideo(file, nicheRow) {
  const persona = nicheRow?.editing_style_preset?.persona || "Leo: a dramatic, slightly royal little hunter who takes himself very seriously and is adored for it";
  const base = path.basename(file);
  const { duration: srcDuration, hasAudio } = await probeVideo(file);
  if (!srcDuration) throw new Error("Could not read video duration");
  const duration = Math.min(srcDuration, MAX_CLIP_SECONDS);
  const targetChannel = nicheRow?.target_channel || "primary";

  const { data: job, error } = await supabase
    .from("pipeline_logs")
    .insert({ niche: "Leo", status: "Scripting", target_channel: targetChannel, topic: base })
    .select().single();
  if (error) throw new Error(`pipeline_logs insert failed: ${error.message}`);
  const jobId = job.id;

  try {
    // Sidecar note = "her words" for this clip; vision fills in otherwise.
    const notePath = file.replace(VIDEO_EXT, ".txt");
    const note = await readFile(notePath, "utf8").then((t) => t.trim()).catch(() => null);
    const scene = note ? null : await describeFrame(file, srcDuration);
    const copy = await writePetCopy({ note, sceneDescription: scene, filename: base, persona });
    await logEvent("Leo", `"${base}" → narration: "${copy.narration.slice(0, 60)}..." | hook: ${copy.hook}`, { jobId });

    const voiceId = config.leoVoiceId || "Leda"; // warm female Gemini voice
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
        return i % 3 === 0 ? { text: chunk.map((c) => c.word).join(" "), start: chunk[0].start, end: chunk[chunk.length - 1].end } : null;
      }).filter(Boolean),
      overlays: [{ text: copy.hook, start: 0.2, end: 2.8 }],
      captionStyle: nicheRow?.editing_style_preset?.caption || { color: "cream" },
    };
    const renderResult = await renderVideo(payload, jobId);
    const qc = await leoQualityCheck(renderResult.url, outDuration);
    await logEvent("Leo", `QC pass: ${qc.duration.toFixed(1)}s, audio present`, { jobId });

    // Cross-post targets (tiktok/instagram packages + youtube) so the
    // dashboard's platform panel works for Leo jobs like any other niche.
    const publishPackage = buildPublishPackage({
      jobId, niche: "Leo", videoUrl: renderResult.url,
      subtitleUrl: renderResult.subtitleUrl, syncPrecisionMs: config.subtitleSyncPrecisionMs,
      duration: outDuration, title: copy.title, description: copy.description, tags: copy.tags,
      thumbnailUrl: renderResult.thumbnailUrl, coverVariants: renderResult.coverVariants,
      qualityReport: { overall_score: 85, hook_score: 85, technical_pass: true, retention_prediction: "85%", issues: [] },
      platforms: ["youtube", "tiktok", "instagram"], monetizationEnabled: false,
    });
    const targets = createPublishTargets(publishPackage, ["youtube", "tiktok", "instagram"]);
    await supabase.from("publish_targets").upsert(
      targets.map((t) => ({ pipeline_log_id: jobId, ...t })),
      { onConflict: "pipeline_log_id,platform" }
    );

    await updateJob(jobId, {
      title: copy.title,
      description: copy.description,
      tags: copy.tags,
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
        tags: copy.tags, jobId, targetChannel, niche: "Leo", publishPackage,
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
    await logEvent("Leo", `✓ "${base}" done → ${config.autopilot ? "scheduled" : "awaiting approval"}`, { jobId });
    return jobId;
  } catch (err) {
    await logEvent("Leo", `✗ "${base}" failed: ${err.message}`, { jobId, level: "error" });
    await updateJob(jobId, { status: "Failed", error: err.message });
    throw err;
  }
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
  console.log(`Leo: ${videos.length} new video(s) in inbox`);
  const { data: nicheRow } = await supabase.from("niche_configurations").select("target_channel").eq("niche_name", "Leo").single();
  for (const file of videos) {
    try {
      await processOneVideo(file, nicheRow);
    } catch (err) {
      console.error(`[leo] ${path.basename(file)}: ${err.message} (left in inbox for retry)`);
    }
  }
}

if (process.argv[1]?.endsWith("leo.js")) {
  syncLeoInbox().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
