/**
 * ROUTES: NICHES — lets the dashboard's Channel Routing panel list every
 * niche and reassign which YouTube channel (target_channel) each one
 * uploads to, or toggle a niche active/inactive without touching Supabase
 * directly.
 */
import express from "express";
import { supabase, logEvent } from "../supabase.js";
import { config } from "../config.js";

export const nichesRouter = express.Router();

nichesRouter.get("/channels", (_req, res) => {
  res.json({ channels: ["primary", ...Object.keys(config.google.channels)] });
});

nichesRouter.get("/niches", async (_req, res) => {
  const { data, error } = await supabase
    .from("niche_configurations")
    .select("niche_name, active, target_channel, trend_region, target_duration_min_seconds, target_duration_max_seconds")
    .order("niche_name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

nichesRouter.patch("/niches/:name", async (req, res) => {
  const allowed = ["target_channel", "active", "trend_region"];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(patch).length) return res.status(400).json({ error: "No valid fields to update" });

  const { error } = await supabase
    .from("niche_configurations")
    .update(patch)
    .eq("niche_name", req.params.name);
  if (error) return res.status(500).json({ error: error.message });

  await logEvent("Operator", `Updated ${req.params.name}: ${JSON.stringify(patch)}`);
  res.json({ ok: true });
});
