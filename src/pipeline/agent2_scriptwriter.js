/**
 * AGENT 2 — GPT-4o CRITICAL TRIMMER & SCRIPTWRITER
 *
 * 1. Writes a ~45-second narration script with an instant localized hook and
 *    the infinite-loop ending (final words grammatically flow back into the
 *    opening hook).
 * 2. Calculates exact trim points for each sourced clip — which seconds of
 *    each stock clip to use and in what order — so cuts land on script beats
 *    instead of dead footage.
 */
import OpenAI from "openai";
import { config } from "../config.js";
import { logEvent } from "../supabase.js";

const openai = new OpenAI({ apiKey: config.openaiKey });

const SCRIPT_SYSTEM = `You are a short-form retention scriptwriter for faceless vertical video.
Rules, non-negotiable:
- Write in original words. If wiki/lore context is provided, PARAPHRASE it — never copy sentences.
- Length: 100-125 words ≈ 45 seconds of narration at natural pace. EXCEPTION: if
  WORD_CLIP_MODE is true, write 45-65 words instead — short, punchy, built for
  giant single-word/short-phrase captions rather than dense narration.
- Line 1 is the hook: instant, high-tension, no throat-clearing, no "did you know".
- THE LOOP: the script must end mid-sentence such that the final words flow
  grammatically straight back into the first word of the hook. Example:
  hook = "Nobody survives the Lands Between…" / ending = "…and that is why"
  → replay reads "…and that is why Nobody survives the Lands Between".
- Simple spoken language. Short sentences. Every sentence earns the next.
- If WORD_CLIP_MODE is true: favor short, punchy, highly quotable phrases (3-6
  words per beat) over flowing narration — every phrase should work standalone
  as a bold on-screen word/phrase card synced to the voiceover.
- Write the script in the language specified by LANGUAGE (e.g. "en" = natural
  spoken English, "hi" = natural conversational Hindi in Devanagari script).
  Title/description/tags stay in LANGUAGE too, except tags may include common
  English crossover terms if that's how people actually search.
- No hashtags, no emoji, no stage directions in the script body.
Respond ONLY with JSON:
{
  "script": "...",
  "hook_word": "first word of script",
  "loop_tail": "the final mid-sentence fragment",
  "title": "clickbaity title under 40 chars",
  "description": "2-sentence YouTube description",
  "tags": ["tag1", "..."] (12-15 high-CTR tags)
}`;

export async function writeScript(niche, topic, loreContext, jobId) {
  await logEvent("Agent 2", `Writing looped script for "${topic.title.slice(0, 60)}"…`, { jobId });

  const language = niche.language || "en";
  const wordClipMode = Boolean(niche.editing_style_preset?.wordClipMode);

  const context = [
    `NICHE: ${niche.niche_name}`,
    `LANGUAGE: ${language}`,
    `WORD_CLIP_MODE: ${wordClipMode}`,
    `TRENDING TOPIC: ${topic.title}`,
    topic.selftext ? `THREAD CONTEXT: ${topic.selftext}` : null,
    loreContext
      ? `LORE GROUNDING (paraphrase only, do not copy): ${JSON.stringify(loreContext)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.9,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SCRIPT_SYSTEM },
      { role: "user", content: context },
    ],
  });

  const out = JSON.parse(res.choices[0].message.content);
  if (!out.script || out.script.split(/\s+/).length < 60) {
    throw new Error("Script generation returned insufficient content");
  }
  out._usage = { tokens: res.usage?.total_tokens || 0 };
  await logEvent(
    "Agent 2",
    `Script done — loop: "…${out.loop_tail}" → "${out.hook_word}…" | title: ${out.title}`,
    { jobId }
  );
  return out;
}

const TRIM_SYSTEM = `You are a video editor's timing brain. You receive:
- a narration script (~45s)
- a list of stock clips with their durations and the keyword each matched.
Produce a cut list covering the FULL narration duration plus 2s tail:
- Order clips so their subject matter follows the script's emotional arc.
- For each clip choose "start" (seconds into the source clip, skip static/boring
  openings — most stock clips are strongest 1-3s in) and "length" (4-8s for
  fast-cut styles, 6-10s for slow cross-dissolve styles).
- Reuse a clip with a DIFFERENT start window if you run short.
Respond ONLY with JSON:
{"cuts":[{"index":0,"start":2.5,"length":6.0,"reason":"..."}, ...],"total_seconds":47.0}
index refers to the clip's position in the provided list.`;

export async function calculateTrims(script, clips, stylePreset, jobId) {
  await logEvent("Agent 2", `Calculating trim points across ${clips.length} clips…`, { jobId });

  const clipManifest = clips.map((c, i) => ({
    index: i,
    keyword: c.keyword,
    duration: c.duration,
  }));

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: TRIM_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          script,
          pacing: stylePreset.transitions === "fast-cut" ? "fast" : "slow",
          clips: clipManifest,
        }),
      },
    ],
  });

  const { cuts, total_seconds } = JSON.parse(res.choices[0].message.content);
  // Validate + clamp against real clip durations
  const validated = cuts
    .filter((c) => clips[c.index])
    .map((c) => {
      const src = clips[c.index];
      const start = Math.max(0, Math.min(c.start, Math.max(0, src.duration - 4)));
      const length = Math.max(3, Math.min(c.length, src.duration - start));
      return { url: src.url, start, length, credit: src.credit, provider: src.provider };
    });

  if (!validated.length) throw new Error("Trim calculation produced no usable cuts");
  await logEvent(
    "Agent 2",
    `Cut list ready: ${validated.length} cuts, ~${Math.round(total_seconds)}s timeline`,
    { jobId }
  );
  return validated;
}
