/**
 * ROUTES: COST TRACKER — approximate spend across OpenAI, ElevenLabs, and
 * Shotstack, aggregated from pipeline_logs.
 *
 * IMPORTANT HONESTY NOTE: the RATES below are rough placeholder estimates,
 * not verified current pricing — if your actual bill doesn't match what
 * this tracker shows, trust your provider's real dashboard, not this
 * number, and update RATES to match. As of this writing the biggest real
 * cost levers, in likely order of impact, are:
 *   1. Video LENGTH — directly scales ElevenLabs characters, Shotstack
 *      render seconds, and (a little) OpenAI tokens all at once. This is
 *      why video length was tightened (Viral: strict 20-30s) — shorter
 *      videos are the single biggest cost lever available.
 *   2. Shotstack environment — `stage` is free (sandbox, watermarked);
 *      `v1` is paid per render. Keep SHOTSTACK_ENV=stage for all daily/
 *      test runs; use the dashboard's "Render Production" button (see
 *      routes/jobs.js's /render-production) to pay for a real v1 render
 *      only on videos you've actually approved, instead of paying v1
 *      rates on every test run.
 *   3. gpt-4o vs gpt-4o-mini — script/title writing uses gpt-4o (worth the
 *      cost for quality); trim calculation and the format decision engine
 *      both already use gpt-4o-mini (cheaper, appropriate for those more
 *      mechanical tasks).
 */
import express from "express";
import { supabase } from "../supabase.js";

export const costsRouter = express.Router();

const RATES = {
  openaiPerToken: 0.000005, // blended gpt-4o + gpt-4o-mini estimate — VERIFY against platform.openai.com/usage
  elevenlabsPerChar: 0.00003, // Creator-tier ballpark — VERIFY against your ElevenLabs plan's actual per-character rate
  shotstackPerSecond: 0.05, // approx for v1 production renders; stage/sandbox renders are free — VERIFY against your Shotstack plan
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
