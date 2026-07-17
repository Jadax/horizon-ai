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

const SCRIPT_SYSTEM = `You are a short-form retention scriptwriter for faceless vertical video,
writing for a tech-savvy, internet-literate audience (people who follow
tech/gaming/culture closely and can smell disconnected clickbait instantly —
a title that overpromises and underdelivers gets the video reported, not
watched, and kills channel trust).

## SCRIPT RULES (non-negotiable)
- Write in original words. If wiki/lore context is provided, PARAPHRASE it — never copy sentences.
- Length: hit TARGET_WORDS_MIN-TARGET_WORDS_MAX words, which the caller has
  already converted from this niche's configured target duration (short-form
  niches run ~25-45s TikTok/Shorts length; niches where the topic genuinely
  needs more room — a deep Gaming/Lore story, a multi-step Food recipe — can
  run longer, up to a few minutes, when TARGET_WORDS_MAX indicates that).
- Line 1 is the hook: instant, high-tension, no throat-clearing, no "did you know".
- THE LOOP (for short-form, LOOP_MODE=true): the script must end mid-sentence
  such that the final words flow grammatically straight back into the first
  word of the hook. Example: hook = "Nobody survives the Lands Between…" /
  ending = "…and that is why" → replay reads "…and that is why Nobody
  survives the Lands Between". If LOOP_MODE=false (longer-form content),
  just end on a strong, satisfying closing line instead — no loop needed.
- Simple spoken language. Short sentences. Every sentence earns the next.
- If WORD_CLIP_MODE is true: favor short, punchy, highly quotable phrases (3-6
  words per beat) over flowing narration — every phrase should work standalone
  as a bold on-screen word/phrase card synced to the voiceover.
- Write the script in the language specified by LANGUAGE (e.g. "en" = natural
  spoken English, "hi" = natural conversational Hindi in Devanagari script).
  Title/description/tags stay in LANGUAGE too, except tags may include common
  English crossover terms if that's how people actually search.
- No hashtags, no emoji, no stage directions in the script body.

## TITLE ENGINEERING — follow this reasoning process before writing the title
A title's only job is to make the exact video you're about to watch feel
essential to click — never a different, more dramatic video than the one
that actually plays. Work through these steps:

1. IDENTIFY THE SPECIFIC HOOK. Pull the single most concrete, surprising, or
   consequential fact/claim/detail from the script itself — a real name, a
   real number, a real mechanism, a real turn — not a vague category
   ("something shocking happened"). If the script doesn't contain one
   concrete hook-able detail, the topic was too thin; reach for the most
   specific true thing it does say.
2. PICK ONE PROVEN PATTERN that fits that specific hook (don't force a
   pattern that doesn't fit the content):
   - Curiosity gap: names the subject, withholds the resolution ("The One
     Setting Elden Ring Never Explains")
   - Specific number/stakes: a real figure from the script ("$130M Reason
     Reddit Killed Its Own API")
   - Contrarian/reframe: challenges an assumption the audience already holds
   - Direct consequence: states what changes/breaks/ends because of the fact
   - Insider callout: names a specific tool/mechanic/entity a tech-savvy
     viewer already recognizes, signaling "this is for you specifically"
3. CALIBRATE TO A TECH-SAVVY AUDIENCE. Assume the viewer already knows the
   basics of the niche — skip "explain like I'm 5" framing, use precise
   terminology the community actually uses, and never oversell a routine
   fact as history-making. Confidence and specificity read as credible;
   vague superlatives ("insane," "you won't believe," "this changes
   everything") read as bait and get scrolled past by this audience.
4. VERIFY BEFORE FINALIZING: does the title's specific claim actually appear
   in the script, word-for-word in substance? If the title promises
   something the script doesn't deliver, rewrite the title to match the
   script — never the reverse, and never stretch the script's claim to fit
   a punchier title.
5. Keep it under 40 characters where possible; if the specific hook genuinely
   needs more room to stay accurate, prioritize accuracy over the limit.

Respond ONLY with JSON:
{
  "script": "...",
  "hook_word": "first word of script",
  "loop_tail": "the final mid-sentence fragment",
  "title": "the finished title, following the process above",
  "title_reasoning": "1-2 sentences: which specific hook you pulled from the
    script, which pattern you used, and why it fits this audience — this is
    for internal review, never shown to viewers",
  "description": "2-sentence YouTube description that also stays specific to
    the actual script content, not generic hype",
  "tags": ["tag1", "..."] (12-15 high-CTR tags, mixing niche-specific and
    tech-savvy-audience search terms)
}`;

export async function writeScript(niche, topic, loreContext, jobId) {
  await logEvent("Agent 2", `Writing looped script for "${topic.title.slice(0, 60)}"…`, { jobId });

  const language = niche.language || "en";
  const wordClipMode = Boolean(niche.editing_style_preset?.wordClipMode);

  // Duration → word-count range. ~2.3 words/sec is a natural spoken pace.
  // Defaults preserve the original behavior (45s / 25-35s word-clip) for
  // any niche that hasn't set explicit min/max — longer-form niches
  // (Gaming/Lore deep-dives, Food multi-step recipes) can configure a
  // higher target_duration_max_seconds in niche_configurations to unlock
  // longer scripts. LOOP_MODE turns off automatically past ~70s, since the
  // infinite-loop mechanic is a short-form retention trick, not something
  // that makes sense on a 2-minute video.
  const minSeconds = niche.target_duration_min_seconds || (wordClipMode ? 25 : 40);
  const maxSeconds = niche.target_duration_max_seconds || (wordClipMode ? 35 : 50);
  const wordsMin = Math.round(minSeconds * 2.3);
  const wordsMax = Math.round(maxSeconds * 2.3);
  const loopMode = maxSeconds <= 70;

  const context = [
    `NICHE: ${niche.niche_name}`,
    `LANGUAGE: ${language}`,
    `WORD_CLIP_MODE: ${wordClipMode}`,
    `LOOP_MODE: ${loopMode}`,
    `TARGET_WORDS_MIN: ${wordsMin}`,
    `TARGET_WORDS_MAX: ${wordsMax}`,
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
  const minWords = Math.max(20, Math.round(wordsMin * 0.7)); // allow some natural undershoot
  if (!out.script || out.script.split(/\s+/).length < minWords) {
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

  // TOKEN EFFICIENCY: this is a mechanical timing/ordering task, not
  // creative writing — gpt-4o-mini handles it reliably at a fraction of
  // the cost of gpt-4o, which stays reserved for the script/title work
  // where the extra reasoning quality actually matters.
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
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
  validated._usage = { tokens: res.usage?.total_tokens || 0 };
  await logEvent(
    "Agent 2",
    `Cut list ready: ${validated.length} cuts, ~${Math.round(total_seconds)}s timeline`,
    { jobId }
  );
  return validated;
}
