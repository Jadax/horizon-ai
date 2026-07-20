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
    .select("niche_name, active, target_channel, trend_region, language, target_duration_min_seconds, target_duration_max_seconds, editing_style_preset")
    .order("niche_name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

nichesRouter.patch("/niches/:name", async (req, res) => {
  const allowed = ["target_channel", "active", "trend_region", "language", "social_rss_feeds"];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  // cadence_days lives inside editing_style_preset (jsonb) — no schema
  // change; the daily loop reads it to decide whether a niche runs today.
  const cadenceDays = Number(req.body.cadence_days);
  if (!Object.keys(patch).length && !Number.isFinite(cadenceDays)) return res.status(400).json({ error: "No valid fields to update" });
  if (patch.social_rss_feeds !== undefined && !Array.isArray(patch.social_rss_feeds)) {
    return res.status(400).json({ error: "social_rss_feeds must be an array" });
  }
  if (Number.isFinite(cadenceDays) && cadenceDays >= 1 && cadenceDays <= 30) {
    const { data: row } = await supabase.from("niche_configurations").select("editing_style_preset").eq("niche_name", req.params.name).single();
    patch.editing_style_preset = { ...(row?.editing_style_preset || {}), cadenceDays: Math.round(cadenceDays) };
  }

  const { error } = await supabase
    .from("niche_configurations")
    .update(patch)
    .eq("niche_name", req.params.name);
  if (error) return res.status(500).json({ error: error.message });

  await logEvent("Operator", `Updated ${req.params.name}: ${JSON.stringify(req.body)}`);
  res.json({ ok: true });
});

// Read-only view of the full feed_library reference database (see
// supabase/migration_feed_library.sql) — includes categories with no
// active niche today (Sports, Business, History, etc.), stored for
// future use, never auto-harvested unless promoted into a niche's
// rss_feeds array.
nichesRouter.get("/feed-library", async (req, res) => {
  const category = req.query.category;
  let query = supabase.from("feed_library").select("*").order("category");
  if (category) query = query.eq("category", category);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
