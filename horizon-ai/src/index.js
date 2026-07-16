/**
 * HORIZON AI — SERVER
 * - Express app serving the Operational Command Center dashboard
 * - 03:00 UTC daily cron running the full agent pipeline
 * - SSE live status stream, job APIs, manual override + approval endpoints,
 *   integration diagnostics
 */
import express from "express";
import cron from "node-cron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { supabase, bus, getRecentEvents, logEvent, updateJob } from "./supabase.js";
import { runFullPipeline, runPipelineForNiche } from "./pipeline/run.js";
import { uploadScheduled } from "./pipeline/agent5_upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ── Minimal auth: bearer password on API + dashboard ─────────────────────
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const token =
    req.headers.authorization?.replace("Bearer ", "") || req.query.key;
  if (req.path === "/" && !token) return next(); // dashboard prompts client-side
  if (req.path === "/" || req.path.startsWith("/api")) {
    if (token !== config.dashboardPassword && req.path.startsWith("/api")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "dashboard", "dashboard.html"))
);

// ── LIVE STATUS STREAM (SSE) ─────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  // replay recent history
  for (const e of getRecentEvents().slice(-60)) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    bus.off("event", onEvent);
    clearInterval(ping);
  });
});

// ── Jobs API ─────────────────────────────────────────────────────────────
app.get("/api/jobs", async (_req, res) => {
  const { data, error } = await supabase
    .from("pipeline_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Manual overrides (script/title/description editing while paused)
app.patch("/api/jobs/:id", async (req, res) => {
  const allowed = ["script", "title", "description", "tags", "status"];
  const patch = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  await updateJob(req.params.id, patch);
  await logEvent("Operator", `Manual override applied to job ${req.params.id.slice(0, 8)}`);
  res.json({ ok: true });
});

// Approve + upload a rendered job (used when AUTOPILOT=false)
app.post("/api/jobs/:id/approve", async (req, res) => {
  const { data: job } = await supabase
    .from("pipeline_logs")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (!job?.rendered_video_url)
    return res.status(400).json({ error: "Job has no rendered video" });
  try {
    const result = await uploadScheduled({
      videoUrl: job.rendered_video_url,
      title: job.title,
      description: job.description,
      tags: job.tags,
      jobId: job.id,
    });
    await updateJob(job.id, {
      youtube_video_id: result.videoId,
      target_region: result.region,
      publish_schedule: result.publishAt.toISOString(),
      status: result.held ? "Rendered" : "Scheduled",
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger runs manually
app.post("/api/run", (_req, res) => {
  runFullPipeline().catch((e) => console.error(e));
  res.json({ ok: true, message: "Full pipeline started" });
});
app.post("/api/run/:niche", async (req, res) => {
  const { data: niche } = await supabase
    .from("niche_configurations")
    .select("*")
    .eq("niche_name", req.params.niche)
    .single();
  if (!niche) return res.status(404).json({ error: "Unknown niche" });
  runPipelineForNiche(niche).catch((e) => console.error(e));
  res.json({ ok: true, message: `Pipeline started for ${niche.niche_name}` });
});

// ── CONSOLE DIAGNOSTICS: live integration checks ─────────────────────────
app.get("/api/diagnostics", async (_req, res) => {
  const checks = await Promise.allSettled([
    // OpenAI
    fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${config.openaiKey}` },
    }).then((r) => ({ name: "OpenAI", ok: r.ok })),
    // ElevenLabs
    fetch("https://api.elevenlabs.io/v1/user", {
      headers: { "xi-api-key": config.elevenLabsKey },
    }).then((r) => ({ name: "ElevenLabs", ok: r.ok })),
    // Shotstack
    fetch(`${config.shotstack.baseUrl}/render/00000000-0000-0000-0000-000000000000`, {
      headers: { "x-api-key": config.shotstack.key },
    }).then((r) => ({
      name: `Shotstack (${config.shotstack.env === "v1" ? "Production" : "Sandbox"})`,
      ok: r.status !== 401 && r.status !== 403,
    })),
    // Supabase
    supabase
      .from("niche_configurations")
      .select("id", { count: "exact", head: true })
      .then(({ error }) => ({ name: "Supabase", ok: !error })),
    // Pexels
    config.pexelsKey
      ? fetch("https://api.pexels.com/videos/search?query=test&per_page=1", {
          headers: { Authorization: config.pexelsKey },
        }).then((r) => ({ name: "Pexels", ok: r.ok }))
      : Promise.resolve({ name: "Pexels", ok: false }),
    // Google
    Promise.resolve({
      name: "Google Cloud",
      ok: Boolean(config.google.refreshToken),
    }),
  ]);
  res.json(
    checks.map((c) =>
      c.status === "fulfilled" ? c.value : { name: "unknown", ok: false }
    )
  );
});

// ── The 03:00 UTC set-and-forget loop ────────────────────────────────────
cron.schedule(config.pipelineCron, () => {
  logEvent("Scheduler", `Cron fired (${config.pipelineCron} UTC) — launching daily loop`);
  runFullPipeline().catch((e) =>
    logEvent("Scheduler", `Daily loop crashed: ${e.message}`, { level: "error" })
  );
});

app.listen(config.port, () => {
  console.log(`\n▲ HORIZON AI online → http://localhost:${config.port}`);
  console.log(`  Cron: ${config.pipelineCron} UTC | Autopilot: ${config.autopilot ? "ON" : "OFF"}\n`);
  logEvent("System", `Horizon AI booted — autopilot ${config.autopilot ? "engaged" : "paused"}`);
});
