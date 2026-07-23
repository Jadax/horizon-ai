/**
 * ROUTES: TRENDING & DIAGNOSTICS
 *
 * /api/trending — the ad-hoc "check what's trending right now" tool.
 * Runs the SAME harvesting sources Agent 1 uses for the real pipeline, but
 * returns the full ranked candidate list instead of committing to one and
 * running the rest of the pipeline. Zero OpenAI/ElevenLabs/Shotstack cost —
 * it's just the free harvesting layer, safe to click as often as you like.
 *
 * /api/diagnostics — live connectivity checks for every wired integration.
 */
import express from "express";
import { config } from "../config.js";
import { supabase } from "../supabase.js";
import { harvestAllCandidates } from "../pipeline/agent1_harvester.js";
import { checkRenderEngine } from "../lib/freeVideoRender.js";
import { checkTTSEngine } from "../lib/freeTTS.js";

export const trendingRouter = express.Router();

trendingRouter.get("/trending", async (req, res) => {
  const nicheName = req.query.niche;
  try {
    let niches;
    if (nicheName) {
      const { data, error } = await supabase
        .from("niche_configurations")
        .select("*")
        .eq("niche_name", nicheName)
        .single();
      if (error || !data) return res.status(404).json({ error: `Unknown niche: "${nicheName}"` });
      niches = [data];
    } else {
      const { data, error } = await supabase
        .from("niche_configurations")
        .select("*")
        .eq("active", true);
      if (error) return res.status(500).json({ error: error.message });
      niches = data;
    }

    const results = {};
    for (const niche of niches) {
      const ranked = await harvestAllCandidates(niche);
      results[niche.niche_name] = ranked.slice(0, 12).map((c) => ({
        title: c.title,
        url: c.url,
        source: c.source,
        trendScore: c._trendScore,
        corroboratedBy: c._corroborationCount,
      }));
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

trendingRouter.get("/diagnostics", async (_req, res) => {
  const pexelsKey = (config.pexelsKey || "").trim();
  const pexelsCheck = !pexelsKey
    ? Promise.resolve({ name: "Pexels", ok: false, detail: "PEXELS_API_KEY not set in .env" })
    : fetch("https://api.pexels.com/videos/search?query=test&per_page=1", {
        headers: { Authorization: pexelsKey },
      })
        .then((r) => ({ name: "Pexels", ok: r.ok, detail: r.ok ? `HTTP ${r.status}` : `HTTP ${r.status} — ${r.status === 401 ? "invalid API key" : r.status === 429 ? "rate limited (200/hr limit)" : "request failed"}` }))
        .catch((e) => ({ name: "Pexels", ok: false, detail: `Network error: ${e.message}` }));

  const checks = await Promise.allSettled([
    fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${config.openaiKey}` },
    }).then((r) => ({ name: "OpenAI", ok: r.ok, detail: r.ok ? `HTTP ${r.status}` : `HTTP ${r.status}` })),
    checkTTSEngine().then((ok) => ({ name: `TTS engine (${config.ttsEngine})`, ok, detail: ok ? "operational" : "not reachable" })),
    checkRenderEngine().then((ok) => ({ name: `Render engine (${config.renderEngine})`, ok, detail: ok ? "operational" : "not reachable" })),
    supabase
      .from("niche_configurations")
      .select("id", { count: "exact", head: true })
      .then(({ error }) => ({ name: "Supabase", ok: !error, detail: error ? error.message : "connected" })),
    pexelsCheck,
    Promise.resolve({ name: "Google Cloud", ok: Boolean(config.google.refreshToken), detail: config.google.refreshToken ? "refresh token configured" : "GOOGLE_REFRESH_TOKEN not set" }),
  ]);
  res.json(checks.map((c) => (c.status === "fulfilled" ? c.value : { name: "unknown", ok: false, detail: c.reason?.message || "check failed" })));
});
