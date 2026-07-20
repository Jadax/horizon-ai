import { config } from "../config.js";
import { BANNED_WORDS } from "./monetization.js";
import { llmJson } from "./llm.js";

// The previous "hostile senior editor" prompt had no scoring anchors, so the
// model defaulted to ~60/100 for everything — production runs showed flat
// 60/60/62 scores across revisions of completely different drafts, meaning
// the persona (not the content) set the score and the 85 gate was
// unpassable. Anchored calibration + separating blocking defects from polish
// notes is what makes the gate a real filter instead of a hard wall.
const CRITIC_SYSTEM = `You are a senior short-form video editor doing final review
before publish. Score the supplied script 0-100 in exactly five dimensions:
hook_strength, narrative_flow, information_density, emotional_curve, and
platform_fit. The total is their arithmetic mean.

CALIBRATION — score each dimension against these anchors, independently:
- 90-100: exceptional; top-tier short-form writing for this dimension.
- 80-89: strong, publishable, professional. This is the normal range for a
  specific, well-hooked, tightly-paced script with a real payoff.
- 65-79: competent but noticeably flawed in this dimension.
- 40-64: weak; a structural problem, not a polish problem.
- 0-39: unusable.
A passing total means "would hold its own against good creators in this
niche" — NOT hypothetical perfection. A script with a concrete
pattern-interrupt hook, specific facts, a clear arc, and natural spoken
language belongs in the 80s. Do not deflate scores to seem rigorous; score
what is on the page.

JUDGE WITHIN THE FORMAT. These are 20-40 second vertical shorts, roughly
50-90 spoken words. Score information_density and emotional_curve against
what is achievable in that length: one strong idea, two or three concrete
supporting details, and a single clean emotional turn IS full marks for
this format. Never dock a short script for lacking the depth, sourcing, or
multi-act structure of a long-form video — leanness is the format working,
not a flaw.

Report two separate lists:
- "blocking_issues": ONLY defects that must prevent publishing — fabricated
  or unverifiable factual claims stated as fact, an incoherent narrative, a
  title whose promise the script never delivers, or policy-risky content.
  Empty array if none. Style preferences never go here.
- "improvements": optional polish notes (weaker lines, pacing tweaks).

Return JSON only:
{"scores":{"hook_strength":0,"narrative_flow":0,"information_density":0,"emotional_curve":0,"platform_fit":0},"total":0,"blocking_issues":[],"improvements":[],"revision_notes":[{"line":"...","required_change":"..."}],"passed":false}`;

function deterministicIssues(script, title) {
  const issues = [];
  const words = String(script || "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 20) issues.push(`Script has only ${words.length} words`);
  const banned = BANNED_WORDS.filter((word) => String(script).toLowerCase().includes(word.toLowerCase()));
  if (banned.length) issues.push(`Banned language: ${banned.slice(0, 5).join(", ")}`);
  if (!String(title || "").trim()) issues.push("Title is missing");
  if (String(title || "").length > 100) issues.push("Title exceeds 100 characters");
  if (!/[.!?]/.test(String(script || ""))) issues.push("Script has no sentence structure");
  return issues;
}

export async function gradeContent({ script, title, niche, platforms = ["youtube"] }) {
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
  const dimensions = ["hook_strength", "narrative_flow", "information_density", "emotional_curve", "platform_fit"];
  const scores = Object.fromEntries(dimensions.map((key) => [key, Math.max(0, Math.min(100, Number(review.scores?.[key]) || 0))]));
  const score = Math.round(dimensions.reduce((sum, key) => sum + scores[key], 0) / dimensions.length);
  // Only blocking defects fail a passing score — the old code required
  // issues.length === 0 while ALSO telling the critic to flag vague claims,
  // so even a 90-scoring script was rejected for having one polish note.
  const blockingIssues = Array.isArray(review.blocking_issues) ? review.blocking_issues.map(String) : [];
  const improvements = Array.isArray(review.improvements) ? review.improvements.map(String) : [];
  return {
    score,
    hookScore: scores.hook_strength,
    passed: score >= config.contentQualityThreshold && blockingIssues.length === 0,
    issues: blockingIssues,
    improvements,
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
