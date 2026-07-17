/**
 * ROUTES: LONG-FORM CLIPPER (Agent 6) — upload a video you have rights to,
 * or point at a direct CC-licensed file URL, and kick off transcription +
 * hook-scored clip extraction. See src/pipeline/agent6_clipper.js for why
 * there is deliberately no "paste a YouTube link" endpoint here.
 */
import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { supabase, logEvent } from "../supabase.js";
import { runClipperJob } from "../pipeline/agent6_clipper.js";

export const clipsRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB — Whisper itself caps at 25MB, enforced with a clear error in agent6_clipper.js
});

const BLOCKED_HOSTS = ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"];

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
      error: "YouTube URLs aren't accepted here — this pipeline only takes a direct video file URL (e.g. archive.org, Wikimedia Commons, or your own CDN) that you've verified is CC-licensed or public domain, not a page that requires scraping to extract video.",
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
