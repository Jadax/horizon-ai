/**
 * AGENT 6 — THE LONG-FORM CLIPPER
 *
 * Turns a long-form video into short vertical clips. Two modes, chosen
 * automatically per source based on how much of it is actually spoken:
 *
 *   DIALOGUE MODE (talk-heavy source — podcasts, commentary, interviews):
 *   transcribe with Gemini, ask Gemini to find moments that work as a
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
 * SOURCE RESTRICTION (deliberate): source_type is 'upload' (a file the
 * operator uploaded), 'cc_licensed' (a direct file URL to
 * Creative-Commons/public-domain footage, license_note required), or
 * 'vimeo_own' (fetched via the Vimeo API using the OPERATOR'S OWN personal
 * access token, which Vimeo only honors for videos that token's account
 * owns/has download rights to). 'ytdlp_own' covers YouTube/Twitch/Kick/
 * Instagram/Reddit URLs for publicly accessible content (per CLAUDE.md's
 * SCRAPE POLICY; license_note in routes/clips.js is optional attribution) —
 * none of those platforms expose an official open download API, so yt-dlp
 * is the programmatic downloader; the platform's own "download"/export
 * feature (YouTube Studio, Twitch's VOD export) remains the preferred path
 * when available, and the resulting file can go through the upload path above.
 */
import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { llmJson } from "../lib/llm.js";
import { detectAudioPeaks } from "../lib/audioPeaks.js";
import { renderSourceClip } from "../lib/sourceClipRender.js";
import { execFileAsync as sharedExec } from "../lib/utils.js";
import { transcribeWords, toTranscribableMp3 } from "../lib/geminiTranscribe.js";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "ffmpeg-static";

const execFileAsync = sharedExec;

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

async function fetchSource(job, clipJobId) {
  if (job.source_type === "ytdlp_own") {
    await logEvent("Agent 6", "Downloading video via yt-dlp (platform export is preferred; yt-dlp is the programmatic downloader)…", { jobId: clipJobId });
    const { downloadBestVideo } = await import("../sources/ytDlp.js");
    const { buffer } = await downloadBestVideo(job.source_url, { timeout: 300000 });
    return buffer;
  }
  await logEvent("Agent 6", "Downloading source video…", { jobId: clipJobId });
  const res = await fetch(job.source_url);
  if (!res.ok) throw new Error(`Could not fetch source video: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Cheap container duration probe via ffmpeg metadata (no decode). Lets the
 * dialogue/action decision run BEFORE paying for a full-length PCM extract
 * — talky sources used to always pay the audio-peaks decode just to learn
 * their own duration. */
async function probeMediaDuration(buffer, clipJobId) {
  const inFile = path.join(tmpdir(), `horizon-probe-${randomUUID()}`);
  try {
    await writeFile(inFile, buffer);
    const text = await execFileAsync(ffmpeg, ["-i", inFile], { timeout: 30000 })
      .then((r) => String(r.stderr || ""))
      .catch((e) => String(e.stderr || ""));
    const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(text);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {
    return 0;
  } finally {
    await unlink(inFile).catch(() => {});
  }
}

async function transcribeBuffer(buffer, clipJobId) {
  // ALWAYS extract mono mp3 before sending to Gemini. The old size branch
  // sent small buffers raw but still labeled them "audio/mp3" — an uploaded
  // .mp4/.webm ≤20MB went to the model as mislabeled container data and
  // silently mistranscribed.
  await logEvent("Agent 6", "Extracting audio + transcribing with Gemini (word-level timestamps)…", { jobId: clipJobId });
  const audioBuffer = await toTranscribableMp3(buffer, ffmpeg);
  const words = await transcribeWords(audioBuffer);
  if (!words.length) throw new Error("Gemini transcription returned no words");
  return words;
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

async function planDialogueClips(words, clipJobId, searchIntent = null) {
  await logEvent("Agent 6", `Scanning transcript for standalone-worthy moments${searchIntent ? ` matching: "${searchIntent}"` : ""}…`, { jobId: clipJobId });
  const sentences = toSentenceChunks(words);
  const res = await llmJson({
    tier: "smart",
    temperature: 0.4,
    label: "clipPlanning",
    messages: [
      { role: "system", content: CLIP_SYSTEM },
      {
        role: "user",
        content: [
          searchIntent
            ? `SEARCH INTENT (prioritize moments that deliver exactly this — skip near-misses even if they'd be decent generic clips): ${searchIntent}`
            : null,
          JSON.stringify({ sentences }),
        ].filter(Boolean).join("\n\n"),
      },
    ],
  });
  const { clips } = JSON.parse(res.content || "{}");
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
  return { clips: validated, tokens: res.tokens || 0 };
}

/** Turns detected audio peaks into a clip plan. ONE batched Gemini pass
 * assigns punchier call-out words for every peak that has nearby speech —
 * the old loop fired up to 8 sequential LLM calls for the same job. Peaks
 * with no usable nearby speech (the common case for pure gameplay audio)
 * fall back to a generic impact-word pool at zero API cost. */
async function planActionClips(peaks, words, clipJobId) {
  await logEvent("Agent 6", `Scanning audio for highlight-worthy peaks (no dialogue to hook-score, using loudness instead)…`, { jobId: clipJobId });
  let tokens = 0;

  const snippets = peaks.map((peak) => ({
    peak,
    text: words
      .filter((w) => w.start >= peak.start && w.end <= peak.end)
      .map((w) => w.word)
      .join(" "),
  }));
  const speakable = snippets.filter((s) => s.text.trim().length > 3);
  const suggestions = new Map();
  if (speakable.length) {
    try {
      const res = await llmJson({
        tier: "fast",
        temperature: 0.6,
        label: "clipCallout",
        maxTokens: 400,
        messages: [
          {
            role: "system",
            content:
              'You write on-screen call-outs for loud/exciting moments in a video. For EACH input snippet, reply with ONE punchy 1-4 word ALL-CAPS call-out (e.g. CLUTCH, NO WAY, HE HIT THAT). ' +
              'Return JSON only: {"callouts":[{"index":0,"text":"..."}]} — one entry per input snippet, same order.',
          },
          { role: "user", content: JSON.stringify(speakable.map((s, i) => ({ index: i, snippet: s.text.slice(0, 200) }))) },
        ],
      });
      tokens += res.tokens || 0;
      const parsed = JSON.parse(res.content || "{}");
      for (const c of parsed.callouts || []) {
        const s = speakable[Number(c.index)];
        if (s && c.text) suggestions.set(s.peak, String(c.text).slice(0, 24));
      }
    } catch {
      // fall back to the generic pool silently — this is a nice-to-have, not load-bearing
    }
  }

  const clips = snippets.map(({ peak }) => ({
    mode: "action",
    start: peak.start,
    end: peak.end,
    peakOffset: Number((peak.peakTime - peak.start).toFixed(2)),
    title: suggestions.get(peak) || IMPACT_WORDS[Math.floor(Math.random() * IMPACT_WORDS.length)],
    hook_score: Math.min(10, Math.round(peak.intensity * 3)), // relative loudness vs. baseline, scaled for display only
    reason: `Audio peak ${peak.intensity}x baseline loudness at ${peak.peakTime.toFixed(1)}s`,
  }));
  clips.sort((a, b) => b.hook_score - a.hook_score);
  await logEvent("Agent 6", `Clip plan: ${clips.length} audio-peak highlight(s) found`, { jobId: clipJobId });
  return { clips, tokens };
}

/** sfx_library mirrors music_library's pattern (see agent3_audio.js's
 * pickMusic) — an empty table just means no stinger gets added, same as
 * pickMusic degrading gracefully with no music track. Stock it yourself
 * with royalty-free one-shot SFX (Pixabay's sound-effects library is the
 * same free-commercial-use source already used for footage/music). */
/** Honest post-render QC. Every number below is computed from the ACTUAL
 * artifact (sourceClipRender already hard-fails corrupt output), not
 * fabricated: resolution/sync come from the real renderer result, duration
 * is the real rounded clip length, hook_score is the plan's real score, and
 * retention_estimate is a labeled heuristic (a hook is a necessary but not
 * sufficient condition — nothing here predicts views). Replaces the old
 * Math.max(85, …) block that reported "90%, perfect, zero issues" for every
 * clip regardless of reality. */
function buildClipQualityReport(clip, artifact) {
  const issues = [];
  const duration = Number(artifact.durationSec) || 0;
  if (duration < 15) issues.push(`Clip is ${duration}s — below the 15s Shorts floor`);
  if (duration > 65) issues.push(`Clip is ${duration}s — above the 65s Shorts ceiling`);
  const resW = Number(String(artifact.resolution || "").split("x")[0]);
  const resH = Number(String(artifact.resolution || "").split("x")[1]);
  if (!resW || !resH || resH < 720) issues.push(`Rendered below 720p vertical: ${artifact.resolution || "unknown"}`);
  const sync = Number(artifact.syncPrecisionMs);
  if (!Number.isFinite(sync) || sync > 150) issues.push(`Subtitle sync tolerance ${sync ?? "unknown"}ms — above the 150ms target`);

  const hook = Math.max(0, Math.min(10, Number(clip.hook_score) || 0));
  const tech = issues.length ? 60 : 100;
  const overall = Math.round(hook * 7 + tech * 0.3);
  const retention = Math.round(Math.max(35, Math.min(97, hook * 9.5 - issues.length * 4)));

  return {
    overall_score: overall,
    hook_score: Math.round(hook * 10),
    technical_pass: issues.length === 0,
    retention_estimate: `${retention}% (heuristic — hook strength adjusted for technical issues)`,
    issues,
    checks: {
      resolution: artifact.resolution || null,
      sync_precision_ms: sync ?? null,
      duration_sec: duration,
    },
  };
}

async function renderDialogueClips(sourceBuffer, words, clipPlan, clipJobId) {
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
        quality_report: buildClipQualityReport(clip, artifact),
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
        quality_report: buildClipQualityReport(clip, artifact),
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
    const buffer = await fetchSource(job, clipJobId);
    const words = Array.isArray(job.transcript) && job.transcript.length ? job.transcript : await transcribeBuffer(buffer, clipJobId);
    await updateClipJob(clipJobId, { transcript: words, status: "Analyzing" });

    const spokenSeconds = words.reduce((s, w) => s + Math.max(0, w.end - w.start), 0);
    // Decide dialogue vs action from a cheap metadata probe FIRST — the old
    // flow always ran the full-length PCM decode (detectAudioPeaks) even for
    // pure-talk sources that never use its peaks, just to learn the duration.
    let totalDuration = await probeMediaDuration(buffer, clipJobId);
    if (!totalDuration && words.length) totalDuration = words[words.length - 1].end;
    const speechCoverage = totalDuration ? spokenSeconds / totalDuration : 0;
    const actionMode = speechCoverage < MIN_SPEECH_COVERAGE;
    let peaks = [];
    if (actionMode) {
      peaks = (await detectAudioPeaks(buffer)).peaks || [];
    }

    await logEvent(
      "Agent 6",
      `Speech coverage ${(speechCoverage * 100).toFixed(0)}% → using ${actionMode ? "ACTION mode (audio-peak highlights)" : "DIALOGUE mode (hook-scored transcript)"}`,
      { jobId: clipJobId }
    );

    const { clips, tokens } = actionMode
      ? await planActionClips(peaks, words, clipJobId)
      : await planDialogueClips(words, clipJobId, job.clip_plan?.describe || null);
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
      : await renderDialogueClips(buffer, words, clips, clipJobId);

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
