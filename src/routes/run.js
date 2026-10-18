/**
 * ROUTES: RUN — manual triggers for the pipeline. The same functions the
 * 03:00 UTC cron calls (see src/index.js), exposed for the dashboard's
 * "Run Full Loop" button and per-niche buttons.
 */
import express from "express";
import { supabase, logEvent } from "../supabase.js";
import { runFullPipeline, runPipelineForNiche, isNicheRunning } from "../pipeline/run.js";
import { syncLeoInbox } from "../pipeline/leo.js";

export const runRouter = express.Router();

const VALID_DURATIONS = { short: [15, 15], medium: [55, 60], long: [180, 240] };
const VALID_PLATFORMS = ["youtube", "tiktok", "instagram", "linkedin"];
const VALID_TONES = ["professional", "casual", "dramatic"];
const VALID_SOURCES = ["google", "reddit", "youtube", "youtube_suggest", "gdelt", "rss", "wikipedia", "hackernews", "wikipedia_trending", "bluesky", "twitch", "kick", "dailymotion", "mastodon", "lemmy"];

function applyRunOverrides(niche, body) {
  const duration = body.duration || null;
  const platforms = body.platforms || ["youtube"];
  const tone = body.tone || "casual";
  const trendSources = body.trend_source || niche.editing_style_preset?.trendSources || VALID_SOURCES;
  if (duration && !VALID_DURATIONS[duration]) throw new Error("duration must be short, medium, or long");
  if (!Array.isArray(platforms) || !platforms.length || platforms.some((value) => !VALID_PLATFORMS.includes(value))) throw new Error("platforms contains an unsupported platform");
  if (!VALID_TONES.includes(tone)) throw new Error("tone must be professional, casual, or dramatic");
  if (!Array.isArray(trendSources) || !trendSources.length || trendSources.some((value) => !VALID_SOURCES.includes(value))) throw new Error("trend_source contains an unsupported source");
  return {
    ...niche,
    target_duration_min_seconds: duration ? VALID_DURATIONS[duration][0] : niche.target_duration_min_seconds,
    target_duration_max_seconds: duration ? VALID_DURATIONS[duration][1] : niche.target_duration_max_seconds,
    run_platforms: platforms,
    run_tone: tone,
    run_monetization: body.monetization == null ? undefined : Boolean(body.monetization),
    // agent1_harvester reads trendSources from editing_style_preset.trendSources —
    // writing it there (not a dead run_* column) is what actually restricts sources.
    editing_style_preset: { ...(niche.editing_style_preset || {}), trendSources },
  };
}

runRouter.post("/run", (_req, res) => {
  runFullPipeline().catch((e) => console.error(e));
  res.json({ ok: true, message: "Full pipeline started" });
});

// Scheduler-facing trigger: AWAITS the full run before responding, unlike
// POST /run above (which is fire-and-forget, correct for the dashboard
// button — a human clicking it shouldn't have their browser hang for
// minutes). This one exists for hosts that only allocate CPU to a
// container while a request is in flight (e.g. Cloud Run's default
// request-based billing) — firing the pipeline in the background there
// would get it silently CPU-throttled the moment this handler returns.
// Cloud Scheduler (or any cron caller) should hit THIS route with a long
// timeout instead. Same auth as every other /api route (Bearer
// DASHBOARD_PASSWORD) — Cloud Scheduler supports a custom Authorization
// header on its HTTP target.
runRouter.post("/run/scheduled", async (req, res) => {
  req.setTimeout(0); // no per-request timeout on our side; the host's own limit still applies
  try {
    await runFullPipeline();
    res.json({ ok: true, message: "Full pipeline run complete" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Preferred route — niche name in the request body, safe for names
// containing a "/" (e.g. "Gaming/Lore") which broke the old URL-param route.
runRouter.post("/run-niche", async (req, res) => {
  const nicheName = req.body?.niche;
  if (!nicheName) return res.status(400).json({ error: "Missing niche in request body" });
  const { data: niche, error } = await supabase
    .from("niche_configurations")
    .select("*")
    .eq("niche_name", nicheName)
    .single();
  if (error || !niche) {
    return res.status(404).json({ error: `Unknown niche: "${nicheName}"` });
  }
  // Honest rejection of a duplicate trigger (double-click on the run button).
  if (isNicheRunning(nicheName)) {
    return res.status(409).json({ ok: false, error: `Niche "${nicheName}" already has a run in flight` });
  }
  let configured;
  try {
    configured = applyRunOverrides(niche, req.body || {});
  } catch (validationError) {
    return res.status(400).json({ error: validationError.message });
  }
  // Leo has its own pipeline — dispatch to it instead of the regular one
  if (nicheName === "Leo") {
    logEvent("Leo", "Leo run started — scanning inbox for next clip");
    syncLeoInbox().catch((e) => logEvent("Leo", `Leo run crashed: ${e.message}`, { level: "error" }));
  } else {
    runPipelineForNiche(configured).catch((e) => console.error(e));
  }
  res.json({ ok: true, message: `Pipeline started for ${niche.niche_name}` });
});

// Legacy URL-param route — kept for niches without a slash in the name.
runRouter.post("/run/:niche", async (req, res) => {
  const { data: niche } = await supabase
    .from("niche_configurations")
    .select("*")
    .eq("niche_name", req.params.niche)
    .single();
  if (!niche) return res.status(404).json({ error: "Unknown niche" });
  if (isNicheRunning(req.params.niche)) {
    return res.status(409).json({ ok: false, error: `Niche "${req.params.niche}" already has a run in flight` });
  }
  if (req.params.niche === "Leo") {
    logEvent("Leo", "Leo run started — scanning inbox for next clip");
    syncLeoInbox().catch((e) => logEvent("Leo", `Leo run crashed: ${e.message}`, { level: "error" }));
  } else {
    runPipelineForNiche(niche).catch((e) => console.error(e));
  }
  res.json({ ok: true, message: `Pipeline started for ${niche.niche_name}` });
});
