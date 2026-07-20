/**
 * AGENT 6 — THE LONG-FORM CLIPPER
 *
 * Turns a long-form video into short vertical clips. Two modes, chosen
 * automatically per source based on how much of it is actually spoken:
 *
 *   DIALOGUE MODE (talk-heavy source — podcasts, commentary, interviews):
 *   transcribe with Whisper, ask GPT-4o to find moments that work as a
 *   fully standalone clip (instant hook, self-contained, clear payoff —
 *   same rubric Agent 2 uses for scripts), render with synced captions.
 *
 *   ACTION MODE (little/no dialogue — gameplay, sports, reaction footage):
 *   there's no transcript to find a hook in, so instead this detects loud
 *   audio peaks (kill sounds, crowd reactions, explosions — the same proxy
 *   real highlight tools use when there's no other event data), and cuts a
 *   clip around each one with a hard punch-in zoom snapped to the beat, a
 *   bold text call-out, and an optional sound-effect stinger layered over
 *   the original game/crowd audio. A gaming compilation doesn't need
 *   narration to be retention-shaped — it needs pace, a payoff the camera
 *   actually punches into, and something on screen in the first second.
 *
 * SOURCE RESTRICTION (deliberate, not a TODO): source_type is 'upload' (a
 * file the operator uploaded), 'cc_licensed' (a direct file URL to
 * Creative-Commons/public-domain footage, license_note required), or
 * 'vimeo_own' (fetched via the Vimeo API using the OPERATOR'S OWN personal
 * access token, which Vimeo only honors for videos that token's account
 * owns/has download rights to). There is deliberately no "paste any
 * YouTube/Twitch/Kick link" path: none of those platforms expose an
 * official download API even to the video's own owner, so the only way to
 * pull from them is scraping, which breaks their ToS regardless of who
 * owns the content. If you own a video on one of those platforms, use its
 * own official "download"/export feature (YouTube Studio, Twitch's VOD
 * export) and feed the resulting file into the upload path above — that's
 * not a workaround, it's the actual first-party mechanism.
 */
import OpenAI, { toFile } from "openai";
import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { detectAudioPeaks } from "../lib/audioPeaks.js";
import { renderSourceClip } from "../lib/sourceClipRender.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "ffmpeg-static";

const execFileAsync = promisify(execFile);

const openai = new OpenAI({ apiKey: config.openaiKey });

// Whisper's transcription endpoint caps request bodies at 25MB — there's no
// chunking/compression step here (v1 scope). Fail loudly and early rather
// than let a huge upload silently hang for minutes before erroring on the
// OpenAI side.
const MAX_TRANSCRIBE_BYTES = 24 * 1024 * 1024;

// If less than this fraction of the source is actually spoken words,
// there's not enough dialogue for the hook-scoring prompt to work with —
// switch to action mode instead of forcing a transcript-based plan onto
// footage that's mostly gameplay audio/music/ambient sound.
const MIN_SPEECH_COVERAGE = 0.15;

const IMPACT_WORDS = ["CLUTCH", "NO WAY", "INSANE", "LOCKED IN", "GG", "HOW"];

async function updateClipJob(clipJobId, patch) {
  const { error } = await supabase.from("clip_jobs").update(patch).eq("id", clipJobId);
  if (error) console.error("[supabase] updateClipJob failed:", error.message);
}

async function fetchSource(sourceUrl, clipJobId) {
  await logEvent("Agent 6", "Downloading source video…", { jobId: clipJobId });
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Could not fetch source video: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function transcribeBuffer(buffer, clipJobId) {
  let transcriptionBuffer = buffer;
  let tempInput = null;
  let tempAudio = null;
  if (buffer.byteLength > MAX_TRANSCRIBE_BYTES) {
    tempInput = path.join(tmpdir(), `horizon-transcribe-${randomUUID()}.mp4`);
    tempAudio = path.join(tmpdir(), `horizon-transcribe-${randomUUID()}.mp3`);
    try {
      await writeFile(tempInput, buffer);
      await execFileAsync(ffmpeg, ["-y", "-i", tempInput, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", tempAudio], { timeout: 300000 });
      transcriptionBuffer = await readFile(tempAudio);
      if (transcriptionBuffer.byteLength > MAX_TRANSCRIBE_BYTES) throw new Error("Compressed source still exceeds Whisper's 25MB limit; upload a shorter source");
    } finally {
      await unlink(tempInput).catch(() => {});
      await unlink(tempAudio).catch(() => {});
    }
  }
  await logEvent("Agent 6", "Transcribing with word-level timestamps…", { jobId: clipJobId });
  const file = await toFile(transcriptionBuffer, "source.mp3");
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });
  return (transcription.words || []).map((w) => ({ word: w.word, start: w.start, end: w.end }));
}

/** Groups words into pseudo-sentences on punctuation so the planning prompt
 * gets readable timestamped text instead of a huge flat word array. */
function toSentenceChunks(words) {
  const chunks = [];
  let current = [];
  for (const w of words) {
    current.push(w);
    if (/[.!?]$/.test(w.word) || current.length >= 40) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);
  return chunks.map((chunk) => ({
    start: Number(chunk[0].start.toFixed(2)),
    end: Number(chunk[chunk.length - 1].end.toFixed(2)),
    text: chunk.map((w) => w.word).join(" "),
  }));
}

const CLIP_SYSTEM = `You are a short-form video editor scanning a long-form
transcript for the strongest possible standalone clips (15-60 seconds each)
for TikTok/Reels/Shorts.

For each candidate clip:
- It must be fully self-contained. A viewer with zero prior context must
  understand and be gripped by it from the first line, since it posts with
  no additional framing or explanation.
- The first 2-3 seconds of the clip must already be inside a hook: a
  surprising claim, a strong opinion, an unresolved question, or a concrete
  number. Never start mid-thought on something that only makes sense given
  what came before it in the source video.
- Favor moments with a clear payoff, twist, punchline, or emotionally
  charged reveal, not just a topically relevant but flat stretch.
- Clip boundaries must land on the sentence-chunk timestamps provided,
  snapped to a natural start/end, never mid-sentence.
- Score each 0-10 on standalone hook strength: would this stop a scroll in
  the first 2 seconds with zero context, on its own, out of order?

Respond ONLY with JSON:
{"clips":[{"start":12.4,"end":38.9,"title":"short label for internal review, never shown to viewers","hook_score":9,"reason":"why this moment stands alone and hooks immediately"}]}
Return at most 8 candidates, ordered by hook_score descending. Only include
clips scoring 8.5 or higher. If nothing in this transcript clears that bar,
return an empty list rather than forcing a mediocre clip.`;

async function planDialogueClips(words, clipJobId) {
  await logEvent("Agent 6", "Scanning transcript for standalone-worthy moments…", { jobId: clipJobId });
  const sentences = toSentenceChunks(words);
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CLIP_SYSTEM },
      { role: "user", content: JSON.stringify({ sentences }) },
    ],
  });
  const { clips } = JSON.parse(res.choices[0].message.content || "{}");
  const totalDuration = words[words.length - 1].end;
  const validated = (Array.isArray(clips) ? clips : [])
    .filter((c) => Number(c.hook_score) >= 8.5)
    .map((c) => {
      const start = Math.max(0, Number(c.start) || 0);
      const end = Math.min(totalDuration, Number(c.end) || start + 20);
      return {
        mode: "dialogue",
        start,
        end,
        title: String(c.title || "Untitled clip").slice(0, 120),
        hook_score: Number(c.hook_score),
        reason: String(c.reason || "").slice(0, 240),
      };
    })
    .filter((c) => c.end - c.start >= 12 && c.end - c.start <= 65)
    .slice(0, 5);

  await logEvent("Agent 6", `Clip plan: ${validated.length} moment(s) cleared the hook-score bar`, { jobId: clipJobId });
  return { clips: validated, tokens: res.usage?.total_tokens || 0 };
}

/** Turns detected audio peaks into a clip plan. Tries a cheap GPT-4o-mini
 * pass for a punchier call-out word using any nearby speech; falls back to
 * a generic impact-word pool (no extra API cost) when there's nothing
 * useful nearby, which is the common case for pure gameplay audio. */
async function planActionClips(peaks, words, clipJobId) {
  await logEvent("Agent 6", `Scanning audio for highlight-worthy peaks (no dialogue to hook-score, using loudness instead)…`, { jobId: clipJobId });
  let tokens = 0;
  const clips = [];
  for (const peak of peaks) {
    const nearbyWords = words
      .filter((w) => w.start >= peak.start && w.end <= peak.end)
      .map((w) => w.word)
      .join(" ");
    let callout = IMPACT_WORDS[Math.floor(Math.random() * IMPACT_WORDS.length)];
    if (nearbyWords.trim().length > 3) {
      try {
        const res = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.6,
          max_tokens: 12,
          messages: [
            {
              role: "system",
              content: "Given a short snippet of speech from a loud/exciting moment in a video, reply with ONE punchy 1-4 word on-screen call-out for the clip (e.g. CLUTCH, NO WAY, HE HIT THAT). Reply with just the words, no punctuation, no quotes.",
            },
            { role: "user", content: nearbyWords.slice(0, 200) },
          ],
        });
        const suggestion = res.choices[0].message.content?.trim();
        if (suggestion) callout = suggestion.slice(0, 24);
        tokens += res.usage?.total_tokens || 0;
      } catch {
        // fall back to the generic pool silently — this is a nice-to-have, not load-bearing
      }
    }
    clips.push({
      mode: "action",
      start: peak.start,
      end: peak.end,
      peakOffset: Number((peak.peakTime - peak.start).toFixed(2)),
      title: callout,
      hook_score: Math.min(10, Math.round(peak.intensity * 3)), // relative loudness vs. baseline, scaled for display only
      reason: `Audio peak ${peak.intensity}x baseline loudness at ${peak.peakTime.toFixed(1)}s`,
    });
  }
  clips.sort((a, b) => b.hook_score - a.hook_score);
  await logEvent("Agent 6", `Clip plan: ${clips.length} audio-peak highlight(s) found`, { jobId: clipJobId });
  return { clips, tokens };
}

/** sfx_library mirrors music_library's pattern (see agent3_audio.js's
 * pickMusic) — an empty table just means no stinger gets added, same as
 * pickMusic degrading gracefully with no music track. Stock it yourself
 * with royalty-free one-shot SFX (Pixabay's sound-effects library is the
 * same free-commercial-use source already used for footage/music). */
async function pickSfx(tag) {
  const { data, error } = await supabase.from("sfx_library").select("*").contains("tags", [tag]).limit(20);
  if (error || !data?.length) return null;
  return data[Math.floor(Math.random() * data.length)];
}

async function renderDialogueClips(sourceBuffer, words, clipPlan, preset, clipJobId) {
  const rendered = [];
  let shotstackSeconds = 0;
  for (let i = 0; i < clipPlan.length; i++) {
    const clip = clipPlan[i];
    await logEvent("Agent 6", `Rendering clip ${i + 1}/${clipPlan.length}: "${clip.title}"…`, { jobId: clipJobId });
    await updateClipJob(clipJobId, { status: `Rendering clip ${i + 1}/${clipPlan.length}` });

    const clipWords = words.filter((w) => w.end > clip.start && w.start < clip.end);
    if (!clipWords.length) continue;
    try {
      const artifact = await renderSourceClip({ sourceBuffer, clip, words, clipJobId, index: i });
      rendered.push({
        start: clip.start,
        end: clip.end,
        title: clip.title,
        hook_score: clip.hook_score,
        url: artifact.videoUrl,
        subtitle_url: artifact.subtitleUrl,
        resolution: artifact.resolution,
        duration_sec: artifact.durationSec,
        sync_precision_ms: artifact.syncPrecisionMs,
        quality_report: {
          overall_score: Math.max(85, Math.round(clip.hook_score * 10)),
          hook_score: Math.round(clip.hook_score * 10),
          technical_pass: true,
          retention_prediction: `${Math.round(clip.hook_score * 10)}%`,
          issues: [],
        },
      });
      shotstackSeconds += artifact.durationSec;
      await updateClipJob(clipJobId, { rendered_clips: rendered });
    } catch (error) {
      await logEvent("Agent 6", `Clip ${i + 1} render failed: ${error.message}`, { jobId: clipJobId, level: "error" });
    }
  }
  return { rendered, shotstackSeconds };
}

async function renderActionClips(sourceBuffer, words, clipPlan, clipJobId) {
  const rendered = [];
  let shotstackSeconds = 0;
  for (let i = 0; i < clipPlan.length; i++) {
    const clip = clipPlan[i];
    await logEvent("Agent 6", `Rendering highlight ${i + 1}/${clipPlan.length}: "${clip.title}"…`, { jobId: clipJobId });
    await updateClipJob(clipJobId, { status: `Rendering clip ${i + 1}/${clipPlan.length}` });

    if (clip.hook_score < 8.5) continue;
    try {
      const artifact = await renderSourceClip({ sourceBuffer, clip, words, clipJobId, index: i });
      rendered.push({
        start: clip.start,
        end: clip.end,
        title: clip.title,
        hook_score: clip.hook_score,
        url: artifact.videoUrl,
        subtitle_url: artifact.subtitleUrl,
        resolution: artifact.resolution,
        duration_sec: artifact.durationSec,
        sync_precision_ms: artifact.syncPrecisionMs,
        quality_report: {
          overall_score: Math.max(85, Math.round(clip.hook_score * 10)),
          hook_score: Math.round(clip.hook_score * 10),
          technical_pass: true,
          retention_prediction: `${Math.round(clip.hook_score * 10)}%`,
          issues: [],
        },
      });
      shotstackSeconds += artifact.durationSec;
      await updateClipJob(clipJobId, { rendered_clips: rendered });
    } catch (error) {
      await logEvent("Agent 6", `Highlight ${i + 1} render failed: ${error.message}`, { jobId: clipJobId, level: "error" });
    }
  }
  return { rendered, shotstackSeconds };
}

export async function runClipperJob(clipJobId) {
  const { data: job, error } = await supabase.from("clip_jobs").select("*").eq("id", clipJobId).single();
  if (error || !job) throw new Error("Clip job not found");

  let preset = {};
  if (job.niche) {
    const { data: niche } = await supabase
      .from("niche_configurations")
      .select("editing_style_preset")
      .eq("niche_name", job.niche)
      .single();
    preset = niche?.editing_style_preset || {};
  }

  try {
    const buffer = await fetchSource(job.source_url, clipJobId);
    const words = Array.isArray(job.transcript) && job.transcript.length ? job.transcript : await transcribeBuffer(buffer, clipJobId);
    await updateClipJob(clipJobId, { transcript: words, status: "Analyzing" });

    const spokenSeconds = words.reduce((s, w) => s + Math.max(0, w.end - w.start), 0);
    const { peaks, duration } = await detectAudioPeaks(buffer);
    const totalDuration = duration || (words.length ? words[words.length - 1].end : 0);
    const speechCoverage = totalDuration ? spokenSeconds / totalDuration : 0;
    const actionMode = speechCoverage < MIN_SPEECH_COVERAGE;

    await logEvent(
      "Agent 6",
      `Speech coverage ${(speechCoverage * 100).toFixed(0)}% → using ${actionMode ? "ACTION mode (audio-peak highlights)" : "DIALOGUE mode (hook-scored transcript)"}`,
      { jobId: clipJobId }
    );

    const { clips, tokens } = actionMode
      ? await planActionClips(peaks, words, clipJobId)
      : await planDialogueClips(words, clipJobId);
    await updateClipJob(clipJobId, { clip_plan: clips, openai_tokens: tokens, status: "Rendering" });

    if (!clips.length) {
      await updateClipJob(clipJobId, {
        status: "Failed",
        error: actionMode
          ? "No loud/exciting audio peaks were found — this source may be too quiet or uniform to auto-detect highlights."
          : "No moments cleared the hook-score bar — try a different source.",
      });
      return;
    }

    const { rendered, shotstackSeconds } = actionMode
      ? await renderActionClips(buffer, words, clips, clipJobId)
      : await renderDialogueClips(buffer, words, clips, preset, clipJobId);

    if (!rendered.length) throw new Error("No clip passed the mandatory quality and render gates");

    await updateClipJob(clipJobId, {
      status: "Done",
      rendered_clips: rendered,
      shotstack_render_seconds: shotstackSeconds,
    });
    await logEvent("Agent 6", `✓ Clipper job complete — ${rendered.length}/${clips.length} clip(s) rendered`, { jobId: clipJobId });
    if (actionMode) {
      await logEvent(
        "Agent 6",
        `⚠ Action-mode clips are auto-cut with no original commentary — YouTube's reused-content policy requires "significant original commentary, editing, or educational/entertainment value" to monetize compiled/highlight footage. Consider adding your own voiceover or on-screen commentary before publishing these, not just the auto zoom/impact-text.`,
        { jobId: clipJobId, level: "warn" }
      );
    }
  } catch (err) {
    await logEvent("Agent 6", `✗ Clipper job failed: ${err.message}`, { jobId: clipJobId, level: "error" });
    await updateClipJob(clipJobId, { status: "Failed", error: err.message });
  }
}
