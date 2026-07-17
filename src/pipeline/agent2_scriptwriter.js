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

/**
 * POST-PROCESSING SAFETY NET — the system prompt already forbids em-dashes
 * and a list of AI-tell words, but LLMs don't follow instructions with
 * 100% reliability. This is a hard backstop: it runs on every generated
 * script/title/description and (a) strips any em/en-dash that slipped
 * through, replacing it with a comma so the sentence stays readable rather
 * than just deleting a word boundary, and (b) flags (does not silently
 * rewrite) any banned word that made it through, logging it so you can see
 * how often the model actually needs correcting rather than assuming the
 * prompt alone is sufficient.
 */
const BANNED_WORDS = [
  "delve", "delving", "testament", "moreover", "furthermore", "tapestry",
  "boasts", "navigate the", "the landscape of", "gaming landscape", "realm",
  "elevate", "unleash", "unlock the", "game-changer", "in today's world",
  "in the world of", "when it comes to", "it's worth noting",
  "it's important to note", "dive into", "dive deep", "underscore",
  "underscores", "bustling", "myriad", "plethora", "cutting-edge",
  "unprecedented",
];

function sanitizeText(text) {
  if (!text) return { text, flagged: [] };
  // Replace any em/en-dash (with or without surrounding spaces) with a comma
  let clean = text.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");
  const flagged = BANNED_WORDS.filter((w) => clean.toLowerCase().includes(w.toLowerCase()));
  return { text: clean, flagged };
}

const SCRIPT_SYSTEM = `You are a short-form retention scriptwriter for faceless vertical video,
writing for a tech-savvy, internet-literate audience (people who follow
tech/gaming/culture closely and can smell disconnected clickbait instantly —
a title that overpromises and underdelivers gets the video reported, not
watched, and kills channel trust).

## SCRIPT RULES (non-negotiable)
- Write in original words. If wiki/lore context is provided, PARAPHRASE it — never copy sentences.
- Length: hit TARGET_WORDS_MIN-TARGET_WORDS_MAX words, which the caller has
  already converted from this niche's configured target duration (short-form
  niches run ~20-45s TikTok/Shorts length; niches where the topic genuinely
  needs more room — a deep Gaming/Lore story, a multi-step Food recipe — can
  run longer, up to a few minutes, when TARGET_WORDS_MAX indicates that).
- Line 1 is the hook: it must land within the first 2.5 seconds of spoken
  audio (roughly the first 5-6 words at natural pace) — a shocking piece of
  context, an unresolved question, or a bold claim the rest of the script
  earns. NEVER open with a greeting ("hey", "so", "okay so", "welcome"), a
  generic intro sentence, or throat-clearing of any kind — the first words
  out of the narrator's mouth must already be inside the hook itself.
- SECOND HOOK AT ~5-6 SECONDS: viewers decide whether to keep watching in
  the first few seconds, but there's a second, steeper drop-off right
  around 5-6 seconds — roughly word 12-14 at natural speaking pace. Land a
  second sharp beat there: a specific number, a reveal, a twist, or a
  reframe of the opening line. Don't just keep building generically —
  something concrete has to land again right at that mark. For longer-form
  content (LOOP_MODE=false), spread 2-3 such beats across the first
  15-20% instead of a single mark.
- THE LOOP (for short-form, LOOP_MODE=true): the script must end mid-sentence
  such that the final words flow grammatically straight back into the first
  word of the hook. Example: hook = "Nobody survives the Lands Between…" /
  ending = "…and that is why" → replay reads "…and that is why Nobody
  survives the Lands Between". If LOOP_MODE=false (longer-form content),
  just end on a strong, satisfying closing line instead — no loop needed.
- TONE: write like a sharp, casual friend explaining something interesting
  out loud, not like a press release or a textbook. Contractions are good
  ("it's", "you're", "that's"). Read every sentence out loud in your head
  before finalizing it — if it sounds stiff, formal, or like something a
  narrator would read off a teleprompter, rewrite it looser.
- PUNCTUATION: never use an em dash (—) or en dash (–) anywhere in the
  script, full stop — not just when it's jammed against a word with no
  space. Also avoid colons and semicolons — they read as written-for-the-
  page structure, not something a person would actually say out loud. Use
  a comma, a period, or just start a new sentence instead.
- BANNED WORDS/PHRASES — these are the words that instantly read as
  AI-generated to anyone paying attention, so none of them appear anywhere
  in the script, title, or description: "delve", "delving", "testament",
  "moreover", "furthermore", "tapestry", "boasts", "navigate" (as in
  "navigate this landscape"), "landscape" (used metaphorically, e.g. "the
  gaming landscape"), "realm", "elevate", "unleash", "unlock" (metaphorical),
  "game-changer", "in today's world", "in the world of", "when it comes to",
  "it's worth noting", "it's important to note", "dive into", "dive deep",
  "underscore", "underscores", "bustling", "vibrant" (as filler), "myriad",
  "plethora", "robust" (as filler), "seamless" (as filler), "cutting-edge"
  (as filler), "unprecedented" (unless literally true and specific).
  If a fact genuinely needs one of these concepts, say it in plain words a
  person would actually use out loud instead.
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

  // Post-processing safety net: strip any em/en-dash that slipped through
  // and flag (don't silently rewrite) any AI-tell word that made it past
  // the prompt's rules.
  const allFlagged = new Set();
  for (const field of ["script", "title", "description"]) {
    if (!out[field]) continue;
    const { text, flagged } = sanitizeText(out[field]);
    out[field] = text;
    flagged.forEach((w) => allFlagged.add(w));
  }
  if (allFlagged.size) {
    await logEvent(
      "Agent 2",
      `⚠ Sanitizer caught banned word(s) despite prompt rules: ${[...allFlagged].join(", ")}`,
      { jobId, level: "warn" }
    );
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
- PACING: for fast-cut styles, cut every 1.5-2.5 seconds — modern
  high-retention short-form video changes what's on screen constantly;
  anything slower reads as static and loses viewers. For slow
  cross-dissolve styles (calm/meditative niches), 3-5 seconds per clip is
  appropriate instead — don't apply fast-cut pacing there, the slower pace
  is intentional for that content.
- For each clip choose "start" (seconds into the source clip, skip static/
  boring openings — most stock clips are strongest 1-3s in) and "length"
  per the pacing rule above.
- Reuse a clip with a DIFFERENT start window if you run short — with
  faster cuts you'll need more total cut points to fill the same duration,
  that's expected.
Respond ONLY with JSON:
{"cuts":[{"index":0,"start":2.5,"length":2.0,"reason":"..."}, ...],"total_seconds":47.0}
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
      const length = Math.max(1.2, Math.min(c.length, src.duration - start));
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
