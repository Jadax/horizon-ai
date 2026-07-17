/**
 * ROUTES: LONG-FORM CLIPPER (Agent 6) — upload a video you have rights to,
 * or point at a direct CC-licensed file URL, and kick off transcription +
 * hook-scored clip extraction. See src/pipeline/agent6_clipper.js for why
 * there is deliberately no "paste a YouTube link" endpoint here.
 */
import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { runClipperJob } from "../pipeline/agent6_clipper.js";

export const clipsRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB — Whisper itself caps at 25MB, enforced with a clear error in agent6_clipper.js
});

// None of these platforms expose an official download API, even to a
// video's own owner — pulling from them means scraping, which breaks their
// ToS regardless of who owns the content. If it's your own video, use the
// platform's own download/export feature and upload the file instead.
const BLOCKED_HOSTS = [
  "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com",
  "twitch.tv", "www.twitch.tv", "clips.twitch.tv",
  "kick.com", "www.kick.com",
];

clipsRouter.get("/clips", async (_req, res) => {
  const { data, error } = await supabase
    .from("clip_jobs")
    .select("id, source_type, source_label, niche, status, clip_plan, rendered_clips, error, created_at")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

clipsRouter.get("/clips/:id", async (req, res) => {
  const { data, error } = await supabase.from("clip_jobs").select("*").eq("id", req.params.id).single();
  if (error || !data) return res.status(404).json({ error: "Clip job not found" });
  res.json(data);
});

clipsRouter.post("/clips/upload", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video file uploaded (field name: video)" });
  const niche = req.body.niche || null;

  try {
    const path = `sources/${randomUUID()}.mp4`;
    const { error: uploadError } = await supabase.storage
      .from("uploads")
      .upload(path, req.file.buffer, { contentType: req.file.mimetype || "video/mp4", upsert: true });
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}. Create a public "uploads" bucket in Supabase Storage if you haven't yet.`);

    const { data: pub } = supabase.storage.from("uploads").getPublicUrl(path);

    const { data: job, error } = await supabase
      .from("clip_jobs")
      .insert({
        source_type: "upload",
        source_url: pub.publicUrl,
        source_label: req.file.originalname || null,
        niche,
        status: "Transcribing",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    runClipperJob(job.id).catch((e) => logEvent("Agent 6", `Unhandled clipper error: ${e.message}`, { jobId: job.id, level: "error" }));
    res.status(202).json({ ok: true, jobId: job.id, message: "Clipper job started" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

clipsRouter.post("/clips/from-url", async (req, res) => {
  const { url, license_note, source_label, niche } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "url is required" });
  if (!license_note || !String(license_note).trim()) {
    return res.status(400).json({ error: "license_note is required for CC-licensed sources — record where this footage came from and what license permits reuse" });
  }
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return res.status(400).json({ error: "url is not a valid URL" });
  }
  if (BLOCKED_HOSTS.includes(hostname)) {
    return res.status(400).json({
      error: `${hostname} URLs aren't accepted here — none of YouTube/Twitch/Kick expose an official download API, even to a video's own owner, so pulling from them means scraping, which breaks their ToS. If it's your own video, use that platform's own download/export feature and use the "Upload a video you own" form instead. This pipeline only takes a direct video file URL (e.g. archive.org, Wikimedia Commons, your own CDN) you've verified is CC-licensed or public domain — not a page that requires scraping to extract video.`,
    });
  }

  try {
    const { data: job, error } = await supabase
      .from("clip_jobs")
      .insert({
        source_type: "cc_licensed",
        source_url: url,
        source_label: source_label || null,
        license_note,
        niche: niche || null,
        status: "Transcribing",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    runClipperJob(job.id).catch((e) => logEvent("Agent 6", `Unhandled clipper error: ${e.message}`, { jobId: job.id, level: "error" }));
    res.status(202).json({ ok: true, jobId: job.id, message: "Clipper job started" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vimeo, for videos YOU OWN: unlike YouTube/Twitch/Kick, Vimeo's own API
// returns a "download" array of direct file links when the request is
// authenticated as the video's owner (or another account with explicit
// download rights) — that ownership check is enforced by Vimeo itself, not
// by this route, so there's no way to point this at someone else's video.
clipsRouter.post("/clips/from-vimeo", async (req, res) => {
  if (!config.vimeoAccessToken) {
    return res.status(400).json({ error: "VIMEO_ACCESS_TOKEN is not configured — see .env.example" });
  }
  const { url, niche } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "url is required" });
  const match = url.match(/vimeo\.com\/(?:.*\/)?(\d+)/);
  if (!match) return res.status(400).json({ error: "Could not find a Vimeo video ID in that URL" });
  const videoId = match[1];

  try {
    const vimeoRes = await fetch(`https://api.vimeo.com/videos/${videoId}`, {
      headers: { Authorization: `Bearer ${config.vimeoAccessToken}` },
    });
    if (!vimeoRes.ok) {
      throw new Error(`Vimeo API → HTTP ${vimeoRes.status}: ${(await vimeoRes.text()).slice(0, 200)}`);
    }
    const video = await vimeoRes.json();
    const files = Array.isArray(video.download) ? video.download : [];
    if (!files.length) {
      throw new Error("This Vimeo video has no download files available to your access token — either you don't own it, downloads aren't enabled, or the token lacks the 'private' scope.");
    }
    const best = files.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];

    const { data: job, error } = await supabase
      .from("clip_jobs")
      .insert({
        source_type: "vimeo_own",
        source_url: best.link,
        source_label: video.name || `Vimeo ${videoId}`,
        niche: niche || null,
        status: "Transcribing",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    runClipperJob(job.id).catch((e) => logEvent("Agent 6", `Unhandled clipper error: ${e.message}`, { jobId: job.id, level: "error" }));
    res.status(202).json({ ok: true, jobId: job.id, message: "Clipper job started" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
