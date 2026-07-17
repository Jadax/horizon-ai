/**
 * ROUTES: RUN — manual triggers for the pipeline. The same functions the
 * 03:00 UTC cron calls (see src/index.js), exposed for the dashboard's
 * "Run Full Loop" button and per-niche buttons.
 */
import express from "express";
import { supabase } from "../supabase.js";
import { runFullPipeline, runPipelineForNiche } from "../pipeline/run.js";

export const runRouter = express.Router();

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
  runPipelineForNiche(niche).catch((e) => console.error(e));
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
  runPipelineForNiche(niche).catch((e) => console.error(e));
  res.json({ ok: true, message: `Pipeline started for ${niche.niche_name}` });
});
