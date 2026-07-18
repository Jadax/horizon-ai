/**
 * AGENT 2 — GPT-4o CRITICAL TRIMMER & SCRIPTWRITER
 * 
 * ENHANCED: Retention engineering + pattern interrupts for maximum virality
 */
import OpenAI from "openai";
import { config } from "../config.js";
import { logEvent } from "../supabase.js";
import { getTitlePatternInsight } from "../lib/trendScoring.js";

const TITLE_PATTERNS = ["curiosity_gap", "number_stakes", "contrarian_reframe", "direct_consequence", "insider_callout"];

const openai = new OpenAI({ apiKey: config.openaiKey });

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
  let clean = text.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");
  const flagged = BANNED_WORDS.filter((w) => clean.toLowerCase().includes(w.toLowerCase()));
  return { text: clean, flagged };
}

const SCRIPT_SYSTEM = `You are a short-form retention scriptwriter for faceless vertical video,
writing for a tech-savvy, internet-literate audience (people who follow
tech/gaming/culture closely and can smell disconnected clickbait instantly —
a title that overpromises and underdelivers gets the video reported, not
watched, and kills channel trust).

## RETENTION ENGINEERING (THIS IS YOUR PRIMARY GOAL)
Viewer retention is the #1 factor for the YouTube algorithm. Every line must serve to keep someone watching.

- **PATTERN INTERRUPT (First 2.5 seconds):** The hook MUST be a pattern interrupt — something that shatters the viewer's expectation and grabs their attention. This is not just "a good first line" — it must be shocking, contradictory, or deeply surprising. Open with a claim that seems impossible, a question that demands an answer, or a statement that challenges common belief.
- **SECOND HOOK (5-6 seconds):** After the initial interrupt, land a second concrete beat — a specific number, a name, a consequence, a twist. Viewers decide twice in the first few seconds; give them two reasons to stay.
- **NARRATIVE ARC:** The script must have a clear emotional journey: tension → build-up → payoff. Don't just present facts; create stakes and raise them throughout.
- **THE LOOP (for short-form, LOOP_MODE=true):** the script must end mid-sentence such that the final words flow grammatically straight back into the first word of the hook. Example: hook = "Nobody survives the Lands Between…" / ending = "…and that is why" → replay reads "…and that is why Nobody survives the Lands Between". Never insert a subscribe/follow line here — it would break the loop's grammar and the loop itself is the retention mechanic for this format.
- **ORIGINAL PERSPECTIVE:** at least one line must go beyond restating what happened and offer an actual take — why it matters, what it reveals, a specific implication, a judgment call. Not a generic editorial aside like "and that's crazy" — a concrete, specific point of view a viewer could disagree with.
- **SUBSCRIBE CTA (if LOOP_MODE=false):** Fold a single natural subscribe/follow nudge into the final line or the sentence just before it — phrased as part of the narration a real person would say, never a bolted-on "smash that subscribe button." Skip it entirely if the topic's tone makes any self-reference feel forced.
- **TONE:** write like a sharp, casual friend explaining something interesting out loud, not like a press release or a textbook. Contractions are good ("it's", "you're", "that's"). Read every sentence out loud in your head before finalizing it — if it sounds stiff, formal, or like something a narrator would read off a teleprompter, rewrite it looser.
- **PUNCTUATION:** never use an em dash (—) or en dash (–) anywhere in the script, full stop — not just when it's jammed against a word with no space. Also avoid colons and semicolons — they read as written-for-the-page structure, not something a person would actually say out loud. Use a comma, a period, or just start a new sentence instead.
- **BANNED WORDS/PHRASES:** these are the words that instantly read as AI-generated to anyone paying attention, so none of them appear anywhere in the script, title, or description: "delve", "delving", "testament", "moreover", "furthermore", "tapestry", "boasts", "navigate" (as in "navigate this landscape"), "landscape" (used metaphorically, e.g. "the gaming landscape"), "realm", "elevate", "unleash", "unlock" (metaphorical), "game-changer", "in today's world", "in the world of", "when it comes to", "it's worth noting", "it's important to note", "dive into", "dive deep", "underscore", "underscores", "bustling", "vibrant" (as filler), "myriad", "plethora", "robust" (as filler), "seamless" (as filler), "cutting-edge" (as filler), "unprecedented" (unless literally true and specific).
- Simple spoken language. Short sentences. Every sentence earns the next.
- If WORD_CLIP_MODE is true: favor short, punchy, highly quotable phrases (3-6 words per beat) over flowing narration — every phrase should work standalone as a bold on-screen word/phrase card synced to the voiceover.
- Write the script in the language specified by LANGUAGE (e.g. "en" = natural spoken English, "hi" = natural conversational Hindi in Devanagari script). Title/description/tags stay in LANGUAGE too, except tags may include common English crossover terms if that's how people actually search.
- No hashtags, no emoji, no stage directions in the script body.
- HUMAN DELIVERY: write punctuation for a real performer. Use a short sentence or comma for an intentional breath. Vary sentence length and emphasis naturally; never write a chain of equally weighted slogans.

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
   pattern that doesn't fit the content). Each has a short id in parens —
   that id is what goes in the JSON "title_pattern" field below:
   - Curiosity gap (curiosity_gap): names the subject, withholds the
     resolution ("The One Setting Elden Ring Never Explains")
   - Specific number/stakes (number_stakes): a real figure from the script
     ("$130M Reason Reddit Killed Its Own API")
   - Contrarian/reframe (contrarian_reframe): challenges an assumption the
     audience already holds
   - Direct consequence (direct_consequence): states what changes/breaks/
     ends because of the fact
   - Insider callout (insider_callout): names a specific tool/mechanic/
     entity a tech-savvy viewer already recognizes, signaling "this is for
     you specifically"
   If a PERFORMANCE HINT is provided in the context below, treat it as a
   tiebreaker, not a mandate — only use the historically-stronger pattern
   when it genuinely fits this specific hook as well as another pattern
   would. A worse-fitting title that happens to match past performance data
   is a worse title.
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

## VISUAL PLAN RULES
Create 6-12 entries in narration order. Each query must describe a visible
action, object, place, or emotion from its exact line. Never use filler
terms such as "aesthetic", "cinematic", "calm", or an unrelated generic
prop. If the line mentions writing a letter, query a hand writing on paper
or sealing an envelope, never a candle. If no literal asset exists, use the
closest truthful metaphor and explain why in intent. The visual plan is
internal, never viewer-facing.

## RESPOND ONLY WITH JSON:
{
  "script": "...",
  "hook_word": "first word of script",
  "loop_tail": "the final mid-sentence fragment",
  "title": "the finished title, following the process above",
  "title_pattern": "one of: curiosity_gap | number_stakes | contrarian_reframe | direct_consequence | insider_callout",
  "title_reasoning": "1-2 sentences: which specific hook you pulled from the script, which pattern you used, and why it fits this audience — this is for internal review, never shown to viewers",
  "description": "2-sentence YouTube description that also stays specific to the actual script content, not generic hype",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10", "tag11", "tag12", "tag13", "tag14", "tag15"],
  "visual_plan": [{"line":"exact phrase from the script", "query":"concrete licensed-stock search phrase", "intent":"what viewers see and why it proves the words"}]
}`;

export async function writeScript(niche, topic, loreContext, jobId) {
  await logEvent("Agent 2", `Writing retention-engineered script for "${topic.title.slice(0, 60)}"...`, { jobId });

  const language = niche.language || "en";
  const wordClipMode = Boolean(niche.editing_style_preset?.wordClipMode);
  const minSeconds = niche.target_duration_min_seconds || (wordClipMode ? 25 : 40);
  const maxSeconds = niche.target_duration_max_seconds || (wordClipMode ? 35 : 50);
  const wordsMin = Math.round(minSeconds * 2.3);
  const wordsMax = Math.round(maxSeconds * 2.3);
  const loopMode = maxSeconds <= 70;
  const titlePatternHint = await getTitlePatternInsight(niche.niche_name).catch(() => null);

  const context = [
    `NICHE: ${niche.niche_name}`,
    `LANGUAGE: ${language}`,
    `WORD_CLIP_MODE: ${wordClipMode}`,
    `LOOP_MODE: ${loopMode}`,
    `TARGET_WORDS_MIN: ${wordsMin}`,
    `TARGET_WORDS_MAX: ${wordsMax}`,
    `TRENDING TOPIC: ${topic.title}`,
    topic.selftext ? `THREAD CONTEXT: ${topic.selftext}` : null,
    loreContext ? `LORE GROUNDING (paraphrase only): ${JSON.stringify(loreContext)}` : null,
    titlePatternHint,
  ]
    .filter(Boolean)
    .join("\n\n");

  const minWords = Math.max(20, Math.round(wordsMin * 0.7));
  let out, usedTokens = 0;

  // One bounded retry with an explicit correction before failing the whole
  // run — a single short generation is normal model variance (temperature
  // 0.9), not worth burning the topic/footage/cost that already went into
  // this job over. A second short result after being told exactly how many
  // words it was missing is treated as a real failure, not retried further.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = [
      { role: "system", content: SCRIPT_SYSTEM },
      { role: "user", content: context },
    ];
    if (attempt === 2) {
      messages.push({
        role: "user",
        content: `Your previous script was only ${out.script?.split(/\s+/).length || 0} words — at least ${minWords} are required. Write a new script that actually reaches the TARGET_WORDS range above; add more narrative detail/stakes, don't just repeat the same beats more slowly.`,
      });
    }
    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages,
    });
    usedTokens += res.usage?.total_tokens || 0;
    out = JSON.parse(res.choices[0].message.content);
    if (out.script && out.script.split(/\s+/).length >= minWords) break;
    if (attempt === 2) {
      throw new Error("Script generation returned insufficient content (after retry)");
    }
    await logEvent("Agent 2", `Script came back short (${out.script?.split(/\s+/).length || 0}/${minWords} words) — retrying once...`, { jobId, level: "warn" });
  }
  if (!Array.isArray(out.visual_plan) || out.visual_plan.length < 4) {
    throw new Error("Script generation returned no usable visual plan");
  }
  
  out.visual_plan = out.visual_plan
    .filter((beat) => beat && typeof beat.query === "string" && typeof beat.line === "string")
    .slice(0, 12)
    .map((beat) => ({
      line: beat.line.slice(0, 180),
      query: beat.query.slice(0, 120),
      intent: String(beat.intent || "Direct visual evidence for the narration").slice(0, 220),
    }));
  if (out.visual_plan.length < 4) throw new Error("Visual plan did not contain four valid beats");
  
  out.title_pattern = TITLE_PATTERNS.includes(out.title_pattern) ? out.title_pattern : null;

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
      `⚠ Sanitizer caught banned word(s): ${[...allFlagged].join(", ")}`,
      { jobId, level: "warn" }
    );
  }

  out._usage = { tokens: usedTokens };
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
- SEMANTIC ALIGNMENT (the most important rule): each cut must match what the
  script is literally saying AT THAT POINT in the reading order, not just the
  general mood of the niche. Walk through the script in order and place each
  clip's "keyword" against the specific phrase it's illustrating.
- PACING: for fast-cut styles, cut every 1.5-2.5 seconds. For slow cross-dissolve styles (calm/meditative niches), 3-5 seconds per clip is appropriate.
- For each clip choose "start" (seconds into the source clip, skip static/boring openings) and "length" per the pacing rule above.
- Reuse a clip with a DIFFERENT start window if you run short.
- In "reason", state which specific script phrase this cut illustrates, not just "matches the mood."
- Reject a clip when its semanticCue/visualIntent does not actually depict the assigned script phrase.
Respond ONLY with JSON:
{"cuts":[{"index":0,"start":2.5,"length":2.0,"reason":"illustrates '...'"}, ...],"total_seconds":47.0}
index refers to the clip's position in the provided list.`;

export async function calculateTrims(script, clips, stylePreset, jobId) {
  await logEvent("Agent 2", `Calculating trim points across ${clips.length} clips...`, { jobId });

  const clipManifest = clips.map((c, i) => ({
    index: i,
    keyword: c.keyword,
    semanticCue: c.semanticCue,
    visualIntent: c.visualIntent,
    duration: c.duration,
  }));

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
  const validated = cuts
    .filter((c) => clips[c.index])
    .map((c) => {
      const src = clips[c.index];
      const start = Math.max(0, Math.min(c.start, Math.max(0, src.duration - 4)));
      const length = Math.max(1.2, Math.min(c.length, src.duration - start));
      return {
        url: src.url, start, length, credit: src.credit, provider: src.provider,
        reason: String(c.reason || src.semanticCue || src.keyword).slice(0, 240),
        semanticCue: src.semanticCue || src.keyword,
      };
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