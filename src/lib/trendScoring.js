/**
 * TREND SCORING — ranks harvested candidates by predicted virality and
 * self-adjusts its source weights over time.
 *
 * Ranked signal mix: cross-source corroboration (same story across independent
 * free feeds ≈ current buzz), freshness, specificity, source reliability, and a
 * "Rising vs Breakout" velocity multiplier (see velocityFactor). Twitter/X is
 * deliberately absent (paid-only API); Mastodon stands in as the free
 * Twitter-shaped signal. Weights adjust via `recalibrateWeights` (fast
 * corroboration signal) into the `trend_rules` table, bounded to small nudges
 * per run so a single noisy sample can't swing trust.
 */
import { supabase, logEvent } from "../supabase.js";
import { topicKey } from "./utils.js";

const DEFAULT_WEIGHTS = {
  cross_source_corroboration: 40,
  freshness: 25,
  specificity: 20,
  source_reliability_default: 10,
};

const SOURCE_RELIABILITY_SEED = {
  "YouTube Trending": 18,
  "Google Trends": 16,
  "GDELT": 12,
  "Google News": 12,
  "Mastodon": 8,
  "Lemmy": 8,
  "Reddit (best-effort)": 6,
};

let cachedWeights = null;

export function invalidateTrendWeightCache() {
  cachedWeights = null;
}

async function loadWeights(nicheName = null) {
  const cacheKey = nicheName || "global";
  if (cachedWeights?.[cacheKey]) return cachedWeights[cacheKey];
  const { data, error } = await supabase.from("trend_rules").select("*");
  const weights = { ...DEFAULT_WEIGHTS, sources: { ...SOURCE_RELIABILITY_SEED } };
  for (const row of error ? [] : data || []) {
    if (row.rule_key.startsWith("source:")) {
      weights.sources[row.rule_key.replace("source:", "")] = row.weight;
    } else if (row.rule_key in DEFAULT_WEIGHTS) {
      weights[row.rule_key] = row.weight;
    }
  }
  let learnedQuery = supabase.from("bayesian_posteriors").select("arm_key,posterior_mean,samples").eq("dimension", "source_platform").gte("samples", 3);
  if (nicheName) learnedQuery = learnedQuery.eq("niche", nicheName);
  const { data: learned } = await learnedQuery;
  for (const row of learned || []) {
    weights.sources[row.arm_key] = Math.max(2, Math.min(25, Number(row.posterior_mean) * 25));
  }
  cachedWeights = cachedWeights || {};
  cachedWeights[cacheKey] = weights;
  return weights;
}

function looksSpecific(title) {
  // Heuristic proxy for "has a real hook": a number, a capitalized proper
  // noun run, or a quoted phrase all suggest concreteness over vague hype.
  return /\d/.test(title) || /"[^"]+"/.test(title) || /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3}\b/.test(title);
}

function freshnessScore(pubDate) {
  if (!pubDate) return 0.3; // unknown age — mild penalty, not zero
  const hoursOld = (Date.now() - pubDate) / (1000 * 60 * 60);
  if (hoursOld < 0) return 1;
  return Math.max(0, 1 - hoursOld / 48); // linear decay over 48h
}

/** Normalize a topic title to the stable key used both for corroboration
 * grouping AND for trend_history persistence. */
export { topicKey };

/**
 * VELOCITY / RGR FACTOR (stolen from the Google Trends "Rising vs Breakout"
 * model — pre-peak rising topics score above already-peaked ones). Computes a
 * 0..1.5 multiplier from the persisted count series in `trend_history`:
 *   RGR = (count_now - count_prev) / count_prev
 *   factor = 1 + 1.5 * clamp(RGR, -0.5, +0.5)
 * A climbing topic pushes toward +1.5 (early/rising); a decaying/flat topic
 * drops toward 0.5-1.0 (post-peak or saturated). Neutral (1.0) until there
 * are >=2 usable snapshots, so day-one runs aren't penalized.
 */
export async function velocityFactor(topic, source = null) {
  const key = topicKey(topic);
  if (!key) return 1;
  try {
    const { data, error } = await supabase
      .from("trend_history")
      .select("count, observed_at")
      .eq("topic_key", key)
      .order("observed_at", { ascending: false })
      .limit(2);
    if (error || !data || data.length < 2) return 1;
    const [nowRow, prevRow] = data;
    const now = Number(nowRow.count);
    const prev = Number(prevRow.count);
    if (!prev || !Number.isFinite(now)) return 1;
    const rgr = (now - prev) / prev;
    const clamped = Math.max(-0.5, Math.min(0.5, rgr));
    return +(1 + 1.5 * clamped).toFixed(3);
  } catch {
    return 1;
  }
}

/**
 * Persist a per-run trend snapshot so velocityFactor has a time series to read.
 * Records ONE row per unique topic_key across the ranked candidates (a topic
 * corroborated across N sources that run gets count=N). Bounded to the top
 * MAX_SNAPSHOTS to avoid unbounded write bursts on every harvest loop.
 */
export async function persistTrendSnapshot(candidates) {
  const MAX_SNAPSHOTS = 40;
  const seen = {};
  for (const c of candidates) {
    const key = topicKey(c.title || "");
    if (!key || seen[key]) continue;
    seen[key] = true;
    const count = ((c._corroborationCount || 1) + 1) / 2; // 1..n -> 1..(n+1)/2 for a single row per key
    try {
      await supabase.from("trend_history").insert({
        topic_key: key,
        source: c.source || null,
        count: Math.max(1, Math.round(count)),
        proxy_score: c._trendScore || 0,
      });
    } catch {
      // ignore per-row write failures — velocity is best-effort
    }
    if (Object.keys(seen).length >= MAX_SNAPSHOTS) break;
  }
}

/**
 * Groups candidates by a rough topic key (normalized title prefix) to
 * detect cross-source corroboration — the core "not yet viral but
 * multiple independent signals agree it's rising" detector.
 */
function groupByTopic(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    const key = topicKey(c.title || "");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return groups;
}

/**
 * Scores and ranks every harvested candidate. Returns the full ranked list
 * (not just the winner) so the ad-hoc "check trending now" dashboard tool
 * can show the full picture, not just what the pipeline would auto-pick.
 */
export async function rankCandidates(candidates, nicheName = null) {
  const weights = await loadWeights(nicheName);
  const groups = groupByTopic(candidates);

  return Promise.all(
    candidates.map(async (c) => {
      const key = topicKey(c.title);
      const corroboration = Math.min(1, ((groups.get(key)?.length || 1) - 1) / 3);
      const fresh = freshnessScore(c.pubDate);
      const specific = looksSpecific(c.title || "") ? 1 : 0.3;
      const sourceRel = (weights.sources[c.source] ?? weights.source_reliability_default) / 20;
      // Rising/velocity boost (Google Trends "Rising vs Breakout" steal): a
      // topic whose corroboration count is climbing pre-peak outranks one that
      // already peaked. Multiplies the corroboration+freshness spine.
      const velocity = await velocityFactor(c.title, c.source);

      const score =
        (corroboration * weights.cross_source_corroboration +
        fresh * weights.freshness +
        specific * weights.specificity +
        sourceRel * 100 * 0.01 * weights.source_reliability_default) * velocity;

      return { ...c, _trendScore: Math.round(score * 10) / 10, _velocity: velocity, _corroborationCount: groups.get(key)?.length || 1 };
    })
  ).then((ranked) => ranked.sort((a, b) => b._trendScore - a._trendScore));
}

/**
 * TITLE-PATTERN PERFORMANCE FEEDBACK — computed live (not a cron job) since
 * Agent 2 needs it at generation time, not on a delay. Looks at this
 * niche's own published-and-measured history (title_pattern × yt_views/
 * yt_likes/yt_comments), and returns a one-line hint for the title prompt
 * naming whichever pattern has the strongest track record here — or null
 * if there isn't enough sample size yet to trust a pattern over another
 * (same >=3-per-bucket bar recalibrateWeights uses, so this
 * doesn't start opinionated on day one and overfit on noise).
 */
export async function getTitlePatternInsight(nicheName, minSamplesPerPattern = 3) {
  const { data, error } = await supabase
    .from("pipeline_logs")
    .select("title_pattern, yt_views, yt_likes, yt_comments")
    .eq("niche", nicheName)
    .not("title_pattern", "is", null)
    .not("yt_views", "is", null)
    .limit(200);
  if (error || !data?.length) return null;

  const byPattern = {};
  for (const row of data) {
    const engagement = (row.yt_views || 0) + (row.yt_likes || 0) * 5 + (row.yt_comments || 0) * 10;
    (byPattern[row.title_pattern] = byPattern[row.title_pattern] || []).push(engagement);
  }

  const ranked = Object.entries(byPattern)
    .filter(([, vals]) => vals.length >= minSamplesPerPattern)
    .map(([pattern, vals]) => ({ pattern, avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length }))
    .sort((a, b) => b.avg - a.avg);

  if (ranked.length < 2) return null; // need at least two patterns to compare, not just a lone winner by default

  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  if (worst.avg <= 0 || best.avg / Math.max(1, worst.avg) < 1.3) return null; // not a meaningful enough gap to steer on

  return `PERFORMANCE HINT: in this niche's history, "${best.pattern}" titles average ${(best.avg / Math.max(1, worst.avg)).toFixed(1)}x the engagement of the weakest pattern (n=${best.n}). Prefer it when it genuinely fits this topic's specific hook — never force a pattern that doesn't actually match the content just because it historically performed well.`;
}

/**
 * Modest self-update: sources whose items frequently corroborate with
 * other sources get a small reliability boost; sources that never
 * corroborate with anything get a small nudge down. Run once per full
 * pipeline loop (not per-niche) to avoid over-fitting on a single sample.
 * This is the shallower, faster-signal counterpart to
 * `recalibrateFromPerformance` above, which uses real YouTube stats but
 * only becomes available once videos have had time to accumulate views.
 */
export async function recalibrateWeights(allRankedCandidates) {
  const weights = await loadWeights();
  const perSourceCorroboration = {};
  for (const c of allRankedCandidates) {
    if (!c.source) continue;
    perSourceCorroboration[c.source] = perSourceCorroboration[c.source] || [];
    perSourceCorroboration[c.source].push(c._corroborationCount > 1 ? 1 : 0);
  }

  const updates = [];
  for (const [source, hits] of Object.entries(perSourceCorroboration)) {
    if (hits.length < 3) continue; // not enough samples yet to adjust
    const corroborationRate = hits.reduce((a, b) => a + b, 0) / hits.length;
    const current = weights.sources[source] ?? SOURCE_RELIABILITY_SEED[source] ?? 10;
    // Nudge by at most ±1 per run — deliberately slow so a single noisy
    // run can't swing a source's trust dramatically.
    const nudge = corroborationRate > 0.4 ? 1 : corroborationRate < 0.1 ? -1 : 0;
    const updated = Math.max(2, Math.min(25, current + nudge));
    if (updated !== current) {
      updates.push({ rule_key: `source:${source}`, weight: updated });
    }
  }

  if (updates.length) {
    await supabase.from("trend_rules").upsert(updates, { onConflict: "rule_key" });
    cachedWeights = null; // force reload next call
    await logEvent(
      "Trend Engine",
      `Recalibrated ${updates.length} source weight(s): ${updates.map((u) => `${u.rule_key}→${u.weight}`).join(", ")}`
    );
  }
}
