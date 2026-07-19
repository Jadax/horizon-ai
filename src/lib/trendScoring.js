/**
 * TREND SCORING — the reasoning layer that decides which harvested
 * candidate is the best bet for a video, and self-adjusts its own weights
 * over time based on which signal types most often corroborate each other
 * AND (once available) how videos actually performed on YouTube.
 *
 * HOW "VIRALITY POTENTIAL" IS ACTUALLY RANKED HERE, AND WHY:
 *   - Cross-source corroboration (the same story hitting an RSS feed AND
 *     Google Trends AND a fediverse post) stands in for "current buzz
 *     across independent signals" — the same idea as checking views/
 *     comments across platforms, but without needing paid access to any
 *     one platform's private engagement numbers.
 *   - GDELT + Google News article COUNT for a story is a real proxy for
 *     "how many outlets are covering this" — the same signal "news hits"
 *     would give you, sourced for free.
 *   - YouTube Trending is literal, current view/engagement data — the
 *     most direct "current views" signal available without paid APIs.
 *   - Twitter/X is deliberately NOT a source: X closed free API access
 *     entirely; the only way to read "Twitter comments" now is a paid
 *     enterprise tier, which isn't wired in here. Mastodon (a genuinely
 *     open, Twitter-shaped public conversation layer) is used instead as
 *     the closest free equivalent — not identical, but real and current.
 *   - Once a video is actually published, `recalibrateFromPerformance`
 *     (below) folds in REAL YouTube views/likes/comments — this is the
 *     most trustworthy signal of all, since it's ground truth rather than
 *     a proxy, but it only becomes available after a video has had time
 *     to accumulate real engagement (see performanceTracker.js).
 *
 * WHAT SELF-UPDATING MEANS TODAY vs. THE FURTHER FUTURE STEP:
 *   Two update mechanisms now exist: `recalibrateWeights` (fast, harvest-
 *   time corroboration signal) and `recalibrateFromPerformance` (slower,
 *   ground-truth signal from actual published-video stats). Both adjust
 *   the same `trend_rules` table, bounded to small nudges per run so a
 *   single noisy sample can't swing trust dramatically. The remaining gap
 *   versus a fully mature system: today's performance recalibration
 *   buckets by source HOSTNAME as a proxy, since individual jobs don't yet
 *   store which named source (of possibly several tied for top score) won
 *   the final pick. A future refinement would store that explicitly on
 *   each job for a cleaner per-source-name (not just per-hostname) signal.
 */
import { supabase, logEvent } from "../supabase.js";

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

/**
 * Groups candidates by a rough topic key (normalized title prefix) to
 * detect cross-source corroboration — the core "not yet viral but
 * multiple independent signals agree it's rising" detector.
 */
function groupByTopic(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    const key = (c.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .slice(0, 5)
      .join(" ");
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

  return candidates
    .map((c) => {
      const key = (c.title || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .slice(0, 5)
        .join(" ");
      const corroboration = Math.min(1, ((groups.get(key)?.length || 1) - 1) / 3);
      const fresh = freshnessScore(c.pubDate);
      const specific = looksSpecific(c.title || "") ? 1 : 0.3;
      const sourceRel = (weights.sources[c.source] ?? weights.source_reliability_default) / 20;

      const score =
        corroboration * weights.cross_source_corroboration +
        fresh * weights.freshness +
        specific * weights.specificity +
        sourceRel * 100 * 0.01 * weights.source_reliability_default;

      return { ...c, _trendScore: Math.round(score * 10) / 10, _corroborationCount: groups.get(key)?.length || 1 };
    })
    .sort((a, b) => b._trendScore - a._trendScore);
}

/**
 * Deeper self-update using ACTUAL YouTube performance (views/likes/comments)
 * once videos have had time to accumulate real signal — see
 * src/lib/performanceTracker.js for how that data gets populated. This is
 * the "future step" flagged in this file's header comment, now partially
 * implemented: it nudges source-reliability weights based on which
 * SOURCE a video's winning topic came from and how that video actually
 * performed, not just whether it was corroborated at harvest time.
 */
export async function recalibrateFromPerformance() {
  const { data: jobs, error } = await supabase
    .from("pipeline_logs")
    .select("source_url, yt_views, yt_likes, yt_comments, stats_updated_at")
    .not("yt_views", "is", null)
    .not("source_url", "is", null)
    .order("stats_updated_at", { ascending: false })
    .limit(200);
  if (error || !jobs?.length) return;

  // We don't store which named source (RSS/Trends/etc) won per job today —
  // only the source URL. As a practical proxy, bucket by hostname, which
  // captures "this specific feed/source tends to produce videos that
  // perform well" even without a dedicated source-name column.
  const byHost = {};
  for (const j of jobs) {
    let host;
    try {
      host = new URL(j.source_url).hostname;
    } catch {
      continue;
    }
    const engagement = (j.yt_views || 0) + (j.yt_likes || 0) * 5 + (j.yt_comments || 0) * 10;
    (byHost[host] = byHost[host] || []).push(engagement);
  }

  const weights = await loadWeights();
  const updates = [];
  for (const [host, engagements] of Object.entries(byHost)) {
    if (engagements.length < 3) continue; // need real sample size before trusting this
    const avg = engagements.reduce((a, b) => a + b, 0) / engagements.length;
    const current = weights.sources[host] ?? 10;
    // A source whose videos average strong engagement earns more trust;
    // consistently weak performers get nudged down. Slow, bounded change.
    const nudge = avg > 500 ? 1 : avg < 50 ? -1 : 0;
    const updated = Math.max(2, Math.min(25, current + nudge));
    if (updated !== current) updates.push({ rule_key: `source:${host}`, weight: updated });
  }

  if (updates.length) {
    await supabase.from("trend_rules").upsert(updates, { onConflict: "rule_key" });
    cachedWeights = null;
    await logEvent(
      "Trend Engine",
      `Recalibrated ${updates.length} weight(s) from real YouTube performance: ${updates.map((u) => `${u.rule_key}→${u.weight}`).join(", ")}`
    );
  }
}

/**
 * TITLE-PATTERN PERFORMANCE FEEDBACK — computed live (not a cron job) since
 * Agent 2 needs it at generation time, not on a delay. Looks at this
 * niche's own published-and-measured history (title_pattern × yt_views/
 * yt_likes/yt_comments), and returns a one-line hint for the title prompt
 * naming whichever pattern has the strongest track record here — or null
 * if there isn't enough sample size yet to trust a pattern over another
 * (same >=3-per-bucket bar recalibrateFromPerformance uses, so this
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
