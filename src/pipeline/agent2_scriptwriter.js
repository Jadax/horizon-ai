/**
 * AGENT 2 — GPT-4o CRITICAL TRIMMER & SCRIPTWRITER
 * 
 * ENHANCED: Now includes retention engineering principles and pattern interrupts
 * to maximize viewer retention and viral potential.
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
tech/gaming/culture closely and can smell disconnected clickbait instantly).

## RETENTION ENGINEERING (THIS IS YOUR PRIMARY GOAL)
Viewer retention is the #1 factor for the YouTube algorithm. Every line must serve to keep someone watching.

- **PATTERN INTERRUPT (First 2.5 seconds):** The hook MUST be a pattern interrupt — something that shatters the viewer's expectation and grabs their attention. This is not just "a good first line" — it must be shocking, contradictory, or deeply surprising. Open with a claim that seems impossible, a question that demands an answer, or a statement that challenges common belief.
- **SECOND HOOK (5-6 seconds):** After the initial interrupt, land a second concrete beat — a specific number, a name, a consequence, a twist. Viewers decide twice in the first few seconds; give them two reasons to stay.
- **NARRATIVE ARC:** The script must have a clear emotional journey: tension → build-up → payoff. Don't just present facts; create stakes and raise them throughout.
- **THE LOOP (for short-form, LOOP_MODE=true):** End in a way that makes viewers want to watch again — the infinite loop mechanic is powerful for retention. End mid-sentence such that the final words flow grammatically straight back into the opening hook.
- **ORIGINAL PERSPECTIVE:** At least one line must go beyond restating what happened and offer an actual take — why it matters, what it reveals, a specific implication, a judgment call. Not a generic editorial aside — a concrete, specific point of view.
- **WRITE FOR CAPTIONS:** Short, punchy lines that work as text on screen. Every sentence should be quotable.
- **SUBSCRIBE CTA (if LOOP_MODE=false):** Fold a single natural subscribe/follow nudge into the final line or the sentence just before it — phrased as part of the narration a real person would say, never a bolted-on "smash that subscribe button."
- **TONE:** Write like a sharp, casual friend explaining something interesting out loud. Contractions are good. Read every sentence out loud — if it sounds stiff, rewrite it looser.
- **PUNCTUATION:** Never use em dashes (—) or en dashes (–). Use commas, periods, or start a new sentence instead.
- **BANNED WORDS:** None of: delve, testament, moreover, tapestry, boasts, navigate the landscape, realm, elevate, unleash, unlock, game-changer, in today's world, when it comes to, it's worth noting, underscore, bustling, myriad, plethora, cutting-edge, unprecedented.
- **LANGUAGE:** Write in the language specified by LANGUAGE (e.g. "en" = English, "hi" = Hindi in Devanagari script).

## TITLE ENGINEERING — follow this reasoning process
1. IDENTIFY THE SPECIFIC HOOK: Pull the single most concrete, surprising, or consequential fact/claim/detail from the script itself — a real name, a real number, a real mechanism — not a vague category.
2. PICK ONE PROVEN PATTERN that fits that specific hook:
   - curiosity_gap: names the subject, withholds the resolution
   - number_stakes: a real figure from the script
   - contrarian_reframe: challenges an assumption the audience already holds
   - direct_consequence: states what changes/breaks/ends because of the fact
   - insider_callout: names a specific tool/mechanic/entity a tech-savvy viewer already recognizes
3. CALIBRATE TO A TECH-SAVVY AUDIENCE: Assume the viewer already knows the basics. Skip "explain like I'm 5" framing. Use precise terminology the community actually uses.
4. VERIFY: Does the title's specific claim actually appear in the script? If not, rewrite the title to match the script — never the reverse.
5. Keep it under 40 characters where possible.

## VISUAL PLAN RULES
Create 6-12 entries in narration order. Each query must describe a visible action, object, place, or emotion from its exact line. Never use filler terms such as "aesthetic", "cinematic", "calm", or an unrelated generic prop. If no literal asset exists, use the closest truthful metaphor and explain why in intent.

## RESPOND ONLY WITH JSON
{
  "script": "...",
  "hook_word": "first word of script",
  "loop_tail": "the final mid-sentence fragment",
  "title": "the finished title",
  "title_pattern": "curiosity_gap | number_stakes | contrarian_reframe | direct_consequence | insider_callout",
  "title_reasoning": "1-2 sentences: which specific hook you pulled, which pattern you used, and why it fits",
  "description": "2-sentence YouTube description that stays specific to the actual script content",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10", "tag11", "tag12"],
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
  const minWords = Math.max(20, Math.round(wordsMin * 0.7));
  
  // Validate required fields
  if (!out.script || out.script.split(/\s+/).length < minWords) {
    throw new Error("Script generation returned insufficient content");
  }
  if (!Array.isArray(out.visual_plan) || out.visual_plan.length < 4) {
    throw new Error("Script generation returned no usable visual plan");
  }
  
  // Validate and clean visual_plan
  out.visual_plan = out.visual_plan
    .filter((beat) => beat && typeof beat.query === "string" && typeof beat.line === "string")
    .slice(0, 12)
    .map((beat) => ({
      line: beat.line.slice(0, 180),
      query: beat.query.slice(0, 120),
      intent: String(beat.intent || "Direct visual evidence for the narration").slice(0, 220),
    }));
  if (out.visual_plan.length < 4) throw new Error("Visual plan did not contain four valid beats");
  
  // Validate title_pattern
  out.title_pattern = TITLE_PATTERNS.includes(out.title_pattern) ? out.title_pattern : null;

  // Post-processing safety net
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
- SEMANTIC ALIGNMENT: each cut must match what the script is literally saying AT THAT POINT.
- PACING: for fast-cut styles, cut every 1.5-2.5 seconds. For slow cross-dissolve styles, 3-5 seconds per clip.
- For each clip choose "start" and "length".
- In "reason", state which specific script phrase this cut illustrates.
Respond ONLY with JSON:
{"cuts":[{"index":0,"start":2.5,"length":2.0,"reason":"illustrates '...'"}, ...],"total_seconds":47.0}`;

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