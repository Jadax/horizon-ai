import OpenAI from "openai";
import { config } from "../config.js";
import { BANNED_WORDS } from "./monetization.js";

const openai = new OpenAI({ apiKey: config.openaiKey });

const CRITIC_SYSTEM = `You are Horizon AI's hostile senior video editor.
Score the supplied script from 0-100 in exactly five dimensions: hook_strength,
narrative_flow, information_density, emotional_curve, and platform_fit. The
total is their arithmetic mean. Flag unsupported or vague claims. A total below
85 is a rejection. Return JSON only:
{"scores":{"hook_strength":0,"narrative_flow":0,"information_density":0,"emotional_curve":0,"platform_fit":0},"total":0,"issues":[],"revision_notes":[{"line":"...","required_change":"..."}],"passed":false}`;

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

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CRITIC_SYSTEM },
      { role: "user", content: JSON.stringify({ niche, platforms, title, script }) },
    ],
  });
  const review = JSON.parse(response.choices[0].message.content || "{}");
  const dimensions = ["hook_strength", "narrative_flow", "information_density", "emotional_curve", "platform_fit"];
  const scores = Object.fromEntries(dimensions.map((key) => [key, Math.max(0, Math.min(100, Number(review.scores?.[key]) || 0))]));
  const score = Math.round(dimensions.reduce((sum, key) => sum + scores[key], 0) / dimensions.length);
  const issues = Array.isArray(review.issues) ? review.issues.map(String) : [];
  return {
    score,
    hookScore: scores.hook_strength,
    passed: score >= config.contentQualityThreshold && issues.length === 0,
    issues,
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
