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

// Returns a labeled list of all configured YouTube channels (primary + any
// in GOOGLE_CHANNELS JSON) so the dashboard can show human-readable names
// like "YouTube — Leo" or "YouTube — MythosVibe" instead of opaque keys.
nichesRouter.get("/channels", (_req, res) => {
  const channels = [{ key: "primary", label: "Primary (default YouTube)" }];
  for (const [key, val] of Object.entries(config.google.channels || {})) {
    const handle = val.handle || val.label || key;
    channels.push({ key, label: `YouTube — ${handle}` });
  }
  // Add Instagram handles configured for niches (package-mode cross-post)
  const igChannels = [{ key: "__ig_primary", label: "Instagram — Primary" }];
  for (const [key, val] of Object.entries(config.instagramChannels || {})) {
    igChannels.push({ key, label: `Instagram — ${val.handle || val.label || key}` });
  }
  // Add TikTok channels configured for niches (package-mode cross-post)
  const ttChannels = [{ key: "__tt_primary", label: "TikTok — Primary" }];
  for (const [key, val] of Object.entries(config.tiktokChannels || {})) {
    ttChannels.push({ key, label: `TikTok — ${val.handle || val.label || key}` });
  }
  res.json({ channels, instagramChannels: igChannels, tiktokChannels: ttChannels });
});

nichesRouter.get("/niches", async (_req, res) => {
  const { data, error } = await supabase
    .from("niche_configurations")
    .select("niche_name, active, target_channel, trend_region, language, target_duration_min_seconds, target_duration_max_seconds, editing_style_preset")
    .order("niche_name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// These dashboard-set preset keys DRIVE the pipeline (each is read by the
// stage named): cadenceDays → daily-loop skip window; qualityThreshold →
// agent2/run.js content gate; uploadHourUtc → agent5 publish slot;
// musicEnergy → music pick; caption.color → renderer caption theme;
// persona → Leo copy generation. targetChannels → list of YouTube channel
// keys to publish the same video to (multi-channel fan-out).
// targetInstagramChannels / targetTiktokChannels → per-niche IG/TT routing.
const PRESET_KEYS = {
  cadence_days: { key: "cadenceDays", clean: (v) => (Number(v) >= 1 && Number(v) <= 30 ? Math.round(Number(v)) : undefined) },
  quality_threshold: { key: "qualityThreshold", clean: (v) => (v === null || v === "" ? null : Number(v) >= 50 && Number(v) <= 95 ? Math.round(Number(v)) : undefined) },
  upload_hour_utc: { key: "uploadHourUtc", clean: (v) => (v === null || v === "" ? null : Number(v) >= 0 && Number(v) <= 23.75 ? Number(v) : undefined) },
  music_energy: { key: "musicEnergy", clean: (v) => (v === null || v === "" ? null : ["High", "Chill", "Wonder", "Suspense"].includes(v) ? v : undefined) },
  caption_color: { key: "caption", clean: (v, preset) => (["white", "cream", "yellow", "mint", "sky", "pink"].includes(v) ? { ...(preset.caption || {}), color: v } : undefined) },
  persona: { key: "persona", clean: (v) => (typeof v === "string" ? v.slice(0, 300) : undefined) },
  target_channels: { key: "targetChannels", clean: (v) => (Array.isArray(v) ? v.filter((c) => typeof c === "string" && c.length < 80).slice(0, 10) : undefined) },
  target_instagram_channels: { key: "targetInstagramChannels", clean: (v) => (Array.isArray(v) ? v.filter((c) => typeof c === "string" && c.length < 80).slice(0, 10) : undefined) },
  target_tiktok_channels: { key: "targetTiktokChannels", clean: (v) => (Array.isArray(v) ? v.filter((c) => typeof c === "string" && c.length < 80).slice(0, 10) : undefined) },
};

nichesRouter.patch("/niches/:name", async (req, res) => {
  const allowed = ["target_channel", "active", "trend_region", "language", "social_rss_feeds"];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (patch.social_rss_feeds !== undefined && !Array.isArray(patch.social_rss_feeds)) {
    return res.status(400).json({ error: "social_rss_feeds must be an array" });
  }

  const presetPatches = Object.entries(PRESET_KEYS).filter(([bodyKey]) => bodyKey in req.body);
  if (!Object.keys(patch).length && !presetPatches.length) return res.status(400).json({ error: "No valid fields to update" });
  if (presetPatches.length) {
    const { data: row } = await supabase.from("niche_configurations").select("editing_style_preset").eq("niche_name", req.params.name).single();
    const preset = { ...(row?.editing_style_preset || {}) };
    for (const [bodyKey, spec] of presetPatches) {
      const cleaned = spec.clean(req.body[bodyKey], preset);
      if (cleaned === undefined) return res.status(400).json({ error: `Invalid value for ${bodyKey}` });
      if (cleaned === null) delete preset[spec.key];
      else preset[spec.key] = cleaned;
    }
    patch.editing_style_preset = preset;
  }

  const { error } = await supabase
    .from("niche_configurations")
    .update(patch)
    .eq("niche_name", req.params.name);
  if (error) return res.status(500).json({ error: error.message });

  await logEvent("Operator", `Updated ${req.params.name}: ${JSON.stringify(req.body)}`);
  res.json({ ok: true });
});

// Per-niche production stats for the dashboard's niche cards: run counts,
// success rate, published count, avg quality score, avg duration, last run.
nichesRouter.get("/niches/stats", async (_req, res) => {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("pipeline_logs")
    .select("niche, status, content_quality_score, duration_seconds, created_at")
    .gte("created_at", since)
    .limit(2000);
  if (error) return res.status(500).json({ error: error.message });
  const stats = {};
  for (const row of data || []) {
    const s = (stats[row.niche] ||= { runs: 0, failed: 0, published: 0, scoreSum: 0, scoreN: 0, durSum: 0, durN: 0, lastRun: null });
    s.runs++;
    if (row.status === "Failed") s.failed++;
    if (["Scheduled", "Published"].includes(row.status)) s.published++;
    if (Number.isFinite(Number(row.content_quality_score))) { s.scoreSum += Number(row.content_quality_score); s.scoreN++; }
    if (Number.isFinite(Number(row.duration_seconds))) { s.durSum += Number(row.duration_seconds); s.durN++; }
    if (!s.lastRun || row.created_at > s.lastRun) s.lastRun = row.created_at;
  }
  res.json(Object.fromEntries(Object.entries(stats).map(([niche, s]) => [niche, {
    runs: s.runs,
    successRate: s.runs ? Math.round(100 * (s.runs - s.failed) / s.runs) : null,
    published: s.published,
    avgScore: s.scoreN ? Math.round(s.scoreSum / s.scoreN) : null,
    avgDuration: s.durN ? Math.round(s.durSum / s.durN) : null,
    lastRun: s.lastRun,
  }])));
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
