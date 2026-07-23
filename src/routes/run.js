/**
 * ROUTES: RUN — manual triggers for the pipeline. The same functions the
 * 03:00 UTC cron calls (see src/index.js), exposed for the dashboard's
 * "Run Full Loop" button and per-niche buttons.
 */
import express from "express";
import { supabase } from "../supabase.js";
import { runFullPipeline, runPipelineForNiche } from "../pipeline/run.js";
import { syncLeoInbox } from "../pipeline/leo.js";

export const runRouter = express.Router();

const VALID_DURATIONS = { short: [15, 15], medium: [55, 60], long: [180, 240] };
const VALID_PLATFORMS = ["youtube", "tiktok", "instagram", "linkedin"];
const VALID_TONES = ["professional", "casual", "dramatic"];
const VALID_SOURCES = ["google", "reddit", "youtube", "gdelt", "rss", "wikipedia"];

function applyRunOverrides(niche, body) {
  const duration = body.duration || null;
  const platforms = body.platforms || ["youtube"];
  const tone = body.tone || "casual";
  const trendSources = body.trend_source || VALID_SOURCES;
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
    run_trend_sources: trendSources,
  };
}

runRouter.post("/run", (_req, res) => {
  runFullPipeline().catch((e) => console.error(e));
  res.json({ ok: true, message: "Full pipeline started" });
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
  let configured;
  try {
    configured = applyRunOverrides(niche, req.body || {});
  } catch (validationError) {
    return res.status(400).json({ error: validationError.message });
  }
  // Leo has its own pipeline — dispatch to it instead of the regular one
  if (nicheName === "Leo") {
    syncLeoInbox().catch((e) => console.error(e));
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
  if (req.params.niche === "Leo") {
    syncLeoInbox().catch((e) => console.error(e));
  } else {
    runPipelineForNiche(niche).catch((e) => console.error(e));
  }
  res.json({ ok: true, message: `Pipeline started for ${niche.niche_name}` });
});
