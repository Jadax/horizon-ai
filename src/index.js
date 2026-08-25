/**
 * HORIZON AI — SERVER
 */
import express from "express";
import cron from "node-cron";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { bus, getRecentEvents, logEvent } from "./supabase.js";
import { runFullPipeline } from "./pipeline/run.js";
import { refreshPublishedStats } from "./lib/performanceTracker.js";
import { runWeeklyLearning } from "./lib/closedLoopLearner.js";
import { jobsRouter } from "./routes/jobs.js";
import { runRouter } from "./routes/run.js";
import { trendingRouter } from "./routes/trending.js";
import { costsRouter } from "./routes/costs.js";
import { nichesRouter } from "./routes/niches.js";
import { clipsRouter } from "./routes/clips.js";
import { engageRouter } from "./routes/engage.js";
import { settingsRouter, applySettingsToConfig } from "./routes/settings.js";
import { channelAuthRouter } from "./routes/channelAuth.js";
import { runEngagementPass } from "./pipeline/agent7_engage.js";

// Apply dashboard-saved credentials (settings.json) to the running config at
// boot so they survive process restarts, not just hot-reloads.
applySettingsToConfig();

// Boot guard: the pipeline is Gemini-only, so a missing key means every run
// fails at the first LLM call. Fail loud and early instead of letting the
// first pipeline silently half-die. Durable fix: set GEMINI_API_KEY in the
// deploy env (Cloud Run/Railway) — settings.json is ephemeral per-instance.
if (!config.geminiKey) {
  console.error(
    "\n========================================================\n" +
    "GEMINI_API_KEY is NOT configured.\n" +
    "The pipeline is Gemini-only — every niche run will fail at\n" +
    "[writeScript] / [formatDecision] with 'GEMINI_API_KEY not set'.\n" +
    "Fix (durable): set GEMINI_API_KEY in your deploy env vars\n" +
    "  (Cloud Run: service -> Edit & Deploy -> Variables; Railway:\n" +
    "  service -> Variables), then redeploy. You can also set it via\n" +
    "  the dashboard Settings panel, but that stores it in ephemeral\n" +
    "  settings.json which Cloud Run instances lose on churn.\n" +
    "========================================================\n"
  );
  logEvent("System", "GEMINI_API_KEY is not configured — pipeline will fail all LLM steps", { level: "error", event: "boot_warning" });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ── Minimal auth ─────────────────────────────────────────────────────
import { timingSafeEqual } from "node:crypto";
function passwordMatches(candidate) {
  const a = Buffer.from(String(candidate || ""));
  const b = Buffer.from(String(config.dashboardPassword));
  // Same-length requirement of timingSafeEqual leaks only the length (which
  // is also leaked by every naive comparison) — but the byte comparison
  // itself becomes constant-time.
  return a.length === b.length && timingSafeEqual(a, b);
}
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  // Google's OAuth redirect lands here with no Authorization header/?key —
  // the OAuth code + single-use server-side state nonce are the proof of a
  // legitimate flow (see routes/channelAuth.js).
  if (req.path === "/api/auth/youtube/callback") return next();
  const token = req.headers.authorization?.replace("Bearer ", "") || req.query.key;
  if (req.path === "/" && !token) return next();
  if (req.path.startsWith("/api") && !passwordMatches(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
const { version: SERVER_VERSION } = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8"));
app.get("/api/version", (_req, res) => res.json({ version: SERVER_VERSION }));
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
app.use("/api", settingsRouter);
app.use("/api", channelAuthRouter);
app.use("/api", engageRouter);

// ── Cron jobs ──────────────────────────────────────────────────────
cron.schedule(config.pipelineCron, () => {
  logEvent("Scheduler", `Cron fired (${config.pipelineCron} UTC) — launching daily loop`);
  runFullPipeline().catch((e) => logEvent("Scheduler", `Daily loop crashed: ${e.message}`, { level: "error" }));
});

cron.schedule("0 */6 * * *", async () => {
  await refreshPublishedStats().catch((e) =>
    logEvent("Scheduler", `Stats refresh failed: ${e.message}`, { level: "error" })
  );
});

cron.schedule("0 4 * * 1", () => {
  runWeeklyLearning().catch((e) => logEvent("Scheduler", `Weekly learning failed: ${e.message}`, { level: "error" }));
}, { timezone: "UTC" });

// Agent 7 — engagement passes twice daily so fresh comments get answered
// within hours, not days (reply-velocity is the growth lever). Auto-skips
// when no channels are connected or AUTO_ENGAGE=false (dashboard OPS toggle).
cron.schedule("0 2,14 * * *", () => {
  logEvent("Scheduler", "Engagement cron fired — running Agent 7 pass");
  runEngagementPass().catch((e) =>
    logEvent("Scheduler", `Engagement pass failed: ${e.message}`, { level: "error" })
  );
});

// ── Start server ─────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`\n▲ HORIZON AI online → http://localhost:${config.port}`);
  console.log(`  Cron: ${config.pipelineCron} UTC | Autopilot: ${config.autopilot ? "ON" : "OFF"}\n`);
  logEvent("System", `Horizon AI booted — autopilot ${config.autopilot ? "engaged" : "paused"}`);
});
