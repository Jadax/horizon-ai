/**
 * HORIZON AI — SERVER
 */
import express from "express";
import cron from "node-cron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { bus, getRecentEvents, logEvent } from "./supabase.js";
import { runFullPipeline } from "./pipeline/run.js";
import { refreshPublishedStats } from "./lib/performanceTracker.js";
import { recalibrateFromPerformance } from "./lib/trendScoring.js";
import { jobsRouter } from "./routes/jobs.js";
import { runRouter } from "./routes/run.js";
import { trendingRouter } from "./routes/trending.js";
import { costsRouter } from "./routes/costs.js";
import { nichesRouter } from "./routes/niches.js";
import { clipsRouter } from "./routes/clips.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ── Minimal auth ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const token = req.headers.authorization?.replace("Bearer ", "") || req.query.key;
  if (req.path === "/" && !token) return next();
  if (req.path.startsWith("/api") && token !== config.dashboardPassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "dashboard", "dashboard.html")));

// ── LIVE STATUS STREAM (SSE) ────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  for (const e of getRecentEvents().slice(-60)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    bus.off("event", onEvent);
    clearInterval(ping);
  });
});

// ── Mount route modules ─────────────────────────────────────────────
app.use("/api", jobsRouter);
app.use("/api", runRouter);
app.use("/api", trendingRouter);
app.use("/api", costsRouter);
app.use("/api", nichesRouter);
app.use("/api", clipsRouter);

// ── Cron jobs ──────────────────────────────────────────────────────
cron.schedule(config.pipelineCron, () => {
  logEvent("Scheduler", `Cron fired (${config.pipelineCron} UTC) — launching daily loop`);
  runFullPipeline().catch((e) => logEvent("Scheduler", `Daily loop crashed: ${e.message}`, { level: "error" }));
});

cron.schedule("0 */6 * * *", async () => {
  await refreshPublishedStats().catch((e) =>
    logEvent("Scheduler", `Stats refresh failed: ${e.message}`, { level: "error" })
  );
  await recalibrateFromPerformance().catch((e) =>
    logEvent("Scheduler", `Performance recalibration failed: ${e.message}`, { level: "error" })
  );
});

// ── Start server ─────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`\n▲ HORIZON AI online → http://localhost:${config.port}`);
  console.log(`  Cron: ${config.pipelineCron} UTC | Autopilot: ${config.autopilot ? "ON" : "OFF"}`);
  console.log(`  Publishing to: ${config.publishTo.join(", ")}`);
  console.log(`  Quality threshold: ${config.qualityScoreThreshold}\n`);
  logEvent("System", `Horizon AI booted — autopilot ${config.autopilot ? "engaged" : "paused"}`);
});