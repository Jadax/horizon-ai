import { config } from "../config.js";
import { BANNED_WORDS } from "./utils.js";
import { llmJson } from "./llm.js";

const CRITIC_SYSTEM = `You are the world's best short-form video editor doing final review
before publish. Your judgment determines whether this video gets seen by millions.
Score the supplied script 0-100 in exactly SEVEN dimensions:

1. hook_strength — Does the first 2.5 seconds create an irresistible curiosity gap?
   - 90-100: Pattern interrupt that stops the scroll COLD. Specific, surprising, concrete.
   - 80-89: Strong hook with a clear curiosity gap or emotional trigger.
   - 65-79: Competent but predictable — won't stop a fast scroller.
   - <65: Generic, vague, or clickbait that underdelivers.

2. pattern_interrupt_frequency — Does something change (thought, pace, angle, reveal)
   every 5-7 seconds to prevent attention decay?
   - 90-100: Fresh stimulus every 3-5 lines. Never a dull moment.
   - 80-89: Good pacing — keeps attention but has 1-2 flat spots.
   - <65: Runs on for 10+ seconds without a shift.

3. narrative_flow — Does it build tension → release → payoff naturally?
   - Same calibration as before: specific arc, clean payoff.

4. information_density — One strong, specific, concrete idea per ~15 seconds.
   - Score against what's achievable in short-form. Leanness IS full marks.

5. emotional_curve — Does it make the viewer FEEL something real?
   - 90-100: Genuine emotional turn that lingers after the video ends.
   - 80-89: Clear emotional movement (surprise → warmth → satisfaction etc).
   - <65: Flat, informational-only, no feeling.

6. platform_fit — Optimized for vertical short-form? Punctuation for spoken delivery?
   Short sentences? Contractions? Natural language? No faux-formal AI tone?

7. viral_potential — Would someone SHARE this? Is it surprising, relatable, or remarkable
   enough to send to a friend?
   - 90-100: "I need to send this to someone" energy.
   - 80-89: Strong standalone value, likely to be saved or shared.
   - <65: Consumable but forgettable.

The total is their arithmetic mean. A passing total means "would hold its own
against top creators in this niche" — NOT hypothetical perfection. A script
with a concrete pattern-interrupt hook, specific facts, a clear arc, and
natural spoken language belongs in the 80s.

Report three separate lists:
- "blocking_issues": ONLY defects that must prevent publishing (fabricated facts,
  incoherent narrative, title not delivered by script, policy-risky content).
  Empty array if none. Style preferences never go here.
- "improvements": optional polish notes (weaker lines, pacing tweaks).
- "viral_boosters": 1-3 concrete changes that would most increase shareability/saveability
  (stronger hook angle, more specific number, emotional beat, perspective shift).

Return JSON only:
{"scores":{"hook_strength":0,"pattern_interrupt_frequency":0,"narrative_flow":0,"information_density":0,"emotional_curve":0,"platform_fit":0,"viral_potential":0},"total":0,"blocking_issues":[],"improvements":[],"viral_boosters":[],"revision_notes":[{"line":"...","required_change":"..."}],"passed":false}`;

function deterministicIssues(script, title) {
  const issues = [];
  const words = String(script || "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 20) issues.push(`Script has only ${words.length} words — too short for engagement`);
  if (words.length < 40 && words.length >= 20) {
    // Short scripts are fine for some formats, but flag if suspiciously lean
  }
  const banned = BANNED_WORDS.filter((word) => String(script).toLowerCase().includes(word.toLowerCase()));
  if (banned.length) issues.push(`Banned language: ${banned.slice(0, 5).join(", ")}`);
  if (!String(title || "").trim()) issues.push("Title is missing");
  if (String(title || "").length > 100) issues.push("Title exceeds 100 characters");
  if (!/[.!?]/.test(String(script || ""))) issues.push("Script has no sentence structure");

  // VIRAL checks: first 3 seconds (first ~12 words) must contain a hook element
  const firstWords = words.slice(0, 12).join(" ").toLowerCase();
  const hookSignals = [
    "?", "did you know", "imagine", "here's why", "secret", "nobody", "stop",
    "never", "shocking", "surprising", "hidden", "mistake", "truth", "reveal",
    "actually", "wait", "watch", "look", "see", "this is", "that's why",
    "the only", "every single", "changed every", "most people", "what if",
    "why do", "how to", "number one", "worst", "best", "your", "if you",
    "don't", "can't", "won't", "the secret", "nobody told", "they don't want",
  ];
  const hasHookSignal = hookSignals.some((signal) => firstWords.includes(signal));
  if (!hasHookSignal && words.length > 20) {
    issues.push("Opening lacks a hook signal — first 3s must create curiosity, surprise, or pattern interrupt");
  }

  // Check for pattern interrupt frequency: at ~5s intervals (every ~12 words)
  const sentences = String(script).split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length > 1) {
    let flatCounter = 0;
    for (const sentence of sentences) {
      const sWords = sentence.trim().split(/\s+/).filter(Boolean);
      if (sWords.length > 25) flatCounter++;
    }
    if (flatCounter > 0 && flatCounter >= sentences.length * 0.4) {
      issues.push("Script has run-on sections — pattern interrupts needed every 5-7s");
    }
  }

  return issues;
}

export async function gradeContent({ script, title, niche, platforms = ["youtube"], threshold = null }) {
  const passThreshold = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : config.contentQualityThreshold;
  const hardIssues = deterministicIssues(script, title);
  if (hardIssues.length) {
    return {
      score: 0,
      hookScore: 0,
      passed: false,
      issues: hardIssues,
      revisionNotes: hardIssues.map((issue) => ({ line: "script", required_change: issue })),
      breakdown: null,
    };
  }

  const response = await llmJson({
    tier: "smart",
    temperature: 0,
    label: "gradeContent",
    messages: [
      { role: "system", content: CRITIC_SYSTEM },
      { role: "user", content: JSON.stringify({ niche, platforms, title, script }) },
    ],
  });
  const review = JSON.parse(response.content || "{}");
  const dimensions = ["hook_strength", "pattern_interrupt_frequency", "narrative_flow", "information_density", "emotional_curve", "platform_fit", "viral_potential"];
  const scores = Object.fromEntries(dimensions.map((key) => [key, Math.max(0, Math.min(100, Number(review.scores?.[key]) || 0))]));
  const score = Math.round(dimensions.reduce((sum, key) => sum + scores[key], 0) / dimensions.length);
  const blockingIssues = Array.isArray(review.blocking_issues) ? review.blocking_issues.map(String) : [];
  const improvements = Array.isArray(review.improvements) ? review.improvements.map(String) : [];
  const viralBoosters = Array.isArray(review.viral_boosters) ? review.viral_boosters.map(String) : [];
  return {
    score,
    hookScore: scores.hook_strength,
    viralPotential: scores.viral_potential,
    passed: score >= passThreshold && blockingIssues.length === 0,
    issues: blockingIssues,
    improvements,
    viralBoosters,
    revisionNotes: Array.isArray(review.revision_notes) ? review.revision_notes : [],
    breakdown: scores,
    tokens: response.usage?.total_tokens || 0,
  };
}

export function assertPublishableQuality(job) {
  const score = Number(job?.content_quality_score);
  if (!Number.isFinite(score) || score < config.contentQualityThreshold) {
    throw new Error(`Publishing blocked: certified quality score must be at least ${config.contentQualityThreshold}`);
  }
  if (job?.quality_report?.technical_pass !== true) {
    throw new Error("Publishing blocked: technical quality gate failed");
  }
}
