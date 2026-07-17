/**
 * AGENT 6 — THE LONG-FORM CLIPPER
 *
 * Turns a long-form video INTO short vertical clips: transcribes it
 * (Whisper, word-level timestamps), asks GPT-4o to find the moments that
 * work as a fully standalone clip (same hook-strength rubric Agent 2 uses
 * for scripts — instant hook, self-contained, clear payoff), then renders
 * each accepted moment through the same Shotstack caption pipeline Agent 4
 * uses for the main videos.
 *
 * SOURCE RESTRICTION (deliberate, not a TODO): source_type is only ever
 * 'upload' (a file the operator uploaded themselves) or 'cc_licensed' (a
 * direct file URL to Creative-Commons/public-domain footage, with a
 * required license_note). There is no "paste a YouTube link" path — pulling
 * and re-cutting arbitrary third-party YouTube/social video is a copyright
 * and ToS problem this pipeline does not take on, even though this same
 * technique (transcript → hook-scored moments → auto-cut) is exactly what
 * tools like Vizard/OpusClip do under the hood.
 */
import OpenAI, { toFile } from "openai";
import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { buildClipPayload, render } from "./agent4_shotstack.js";

const openai = new OpenAI({ apiKey: config.openaiKey });

// Whisper's transcription endpoint caps request bodies at 25MB — there's no
// chunking/compression step here (v1 scope). Fail loudly and early rather
// than let a huge upload silently hang for minutes before erroring on the
// OpenAI side.
const MAX_TRANSCRIBE_BYTES = 24 * 1024 * 1024;

async function updateClipJob(clipJobId, patch) {
  const { error } = await supabase.from("clip_jobs").update(patch).eq("id", clipJobId);
  if (error) console.error("[supabase] updateClipJob failed:", error.message);
}

async function transcribeSource(sourceUrl, clipJobId) {
  await logEvent("Agent 6", "Downloading source video for transcription…", { jobId: clipJobId });
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Could not fetch source video: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new Error(
      `Source file is ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB — Whisper's transcription limit is 25MB. Trim or compress the video before uploading (v1 doesn't chunk large files yet).`
    );
  }

  await logEvent("Agent 6", "Transcribing with word-level timestamps…", { jobId: clipJobId });
  const file = await toFile(buffer, "source.mp4");
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });

  const words = (transcription.words || []).map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
  }));
  if (words.length < 10) throw new Error("Transcription returned too little usable speech to clip from");
  await logEvent("Agent 6", `Transcript ready: ${words.length} words, ${Math.round(words[words.length - 1].end)}s`, {
    jobId: clipJobId,
  });
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
clips scoring 7 or higher. If nothing in this transcript clears that bar,
return an empty list rather than forcing a mediocre clip.`;

async function planClips(words, clipJobId) {
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
    .filter((c) => Number(c.hook_score) >= 7)
    .map((c) => {
      const start = Math.max(0, Number(c.start) || 0);
      const end = Math.min(totalDuration, Number(c.end) || start + 20);
      return {
        start,
        end,
        title: String(c.title || "Untitled clip").slice(0, 120),
        hook_score: Number(c.hook_score),
        reason: String(c.reason || "").slice(0, 240),
      };
    })
    .filter((c) => c.end - c.start >= 12 && c.end - c.start <= 65)
    .slice(0, 8);

  await logEvent("Agent 6", `Clip plan: ${validated.length} moment(s) cleared the hook-score bar`, { jobId: clipJobId });
  return { clips: validated, tokens: res.usage?.total_tokens || 0 };
}

async function renderClips(sourceUrl, words, clipPlan, preset, clipJobId) {
  const rendered = [];
  let shotstackSeconds = 0;
  for (let i = 0; i < clipPlan.length; i++) {
    const clip = clipPlan[i];
    await logEvent("Agent 6", `Rendering clip ${i + 1}/${clipPlan.length}: "${clip.title}"…`, { jobId: clipJobId });
    await updateClipJob(clipJobId, { status: `Rendering clip ${i + 1}/${clipPlan.length}` });

    const clipWords = words
      .filter((w) => w.start >= clip.start && w.end <= clip.end)
      .map((w) => ({ word: w.word, start: w.start - clip.start, end: w.end - clip.start }));
    if (!clipWords.length) continue;

    const payload = buildClipPayload({
      sourceUrl,
      clipStart: clip.start,
      clipLength: clip.end - clip.start,
      words: clipWords,
      preset,
      jobId: clipJobId,
    });
    try {
      const { renderId, url } = await render(payload, clipJobId);
      shotstackSeconds += Number((clip.end - clip.start).toFixed(1));
      rendered.push({ ...clip, url, shotstack_render_id: renderId });
      await updateClipJob(clipJobId, { rendered_clips: rendered, shotstack_render_seconds: shotstackSeconds });
    } catch (err) {
      await logEvent("Agent 6", `Clip ${i + 1} render failed: ${err.message}`, { jobId: clipJobId, level: "warn" });
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
    const words = await transcribeSource(job.source_url, clipJobId);
    await updateClipJob(clipJobId, { transcript: words, status: "Analyzing" });

    const { clips, tokens } = await planClips(words, clipJobId);
    await updateClipJob(clipJobId, { clip_plan: clips, openai_tokens: tokens, status: "Rendering" });

    if (!clips.length) {
      await updateClipJob(clipJobId, { status: "Done", error: "No moments cleared the hook-score bar — try a different source." });
      return;
    }

    const { rendered, shotstackSeconds } = await renderClips(job.source_url, words, clips, preset, clipJobId);
    await updateClipJob(clipJobId, {
      status: "Done",
      rendered_clips: rendered,
      shotstack_render_seconds: shotstackSeconds,
    });
    await logEvent("Agent 6", `✓ Clipper job complete — ${rendered.length}/${clips.length} clip(s) rendered`, { jobId: clipJobId });
  } catch (err) {
    await logEvent("Agent 6", `✗ Clipper job failed: ${err.message}`, { jobId: clipJobId, level: "error" });
    await updateClipJob(clipJobId, { status: "Failed", error: err.message });
  }
}
