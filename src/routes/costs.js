/**
 * ROUTES: COST TRACKER — LEGACY ESTIMATE only.
 *
 * The pipeline is now near-$0: Gemini free tier for LLM/TTS/vision, free
 * ffmpeg-static rendering, and Pollinations/stock APIs for visuals. This
 * tracker is kept for historical continuity and aggregates the legacy
 * pipeline_logs columns (openai_tokens, elevenlabs_characters,
 * shotstack_render_seconds) — those columns now hold Gemini token counts
 * and render seconds, so the dollar figures below are meaningless.
 * Do not treat the output as a real bill.
 */
import express from "express";
import { supabase } from "../supabase.js";

export const costsRouter = express.Router();

// Legacy placeholder rates — kept so old rows render, not a real bill.
const RATES = {
  openaiPerToken: 0.000005,
  elevenlabsPerChar: 0.00003,
  shotstackPerSecond: 0.05,
};

costsRouter.get("/costs", async (_req, res) => {
  const { data, error } = await supabase
    .from("pipeline_logs")
    .select("niche, openai_tokens, elevenlabs_characters, shotstack_render_seconds, created_at");
  if (error) return res.status(500).json({ error: error.message });

  const totals = { openai_tokens: 0, elevenlabs_characters: 0, shotstack_render_seconds: 0 };
  const byNiche = {};
  for (const row of data) {
    totals.openai_tokens += row.openai_tokens || 0;
    totals.elevenlabs_characters += row.elevenlabs_characters || 0;
    totals.shotstack_render_seconds += row.shotstack_render_seconds || 0;
    byNiche[row.niche] = byNiche[row.niche] || { jobs: 0, estCost: 0 };
    byNiche[row.niche].jobs += 1;
    byNiche[row.niche].estCost +=
      (row.openai_tokens || 0) * RATES.openaiPerToken +
      (row.elevenlabs_characters || 0) * RATES.elevenlabsPerChar +
      (row.shotstack_render_seconds || 0) * RATES.shotstackPerSecond;
  }
  const estTotalCost =
    totals.openai_tokens * RATES.openaiPerToken +
    totals.elevenlabs_characters * RATES.elevenlabsPerChar +
    totals.shotstack_render_seconds * RATES.shotstackPerSecond;

  res.json({ totals, estTotalCost, byNiche, jobCount: data.length, rates: RATES });
});
