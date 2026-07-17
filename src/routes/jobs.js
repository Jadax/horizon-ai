/**
 * ROUTES: JOBS — list, manual overrides, approval, and retry for
 * individual pipeline_logs rows. See src/pipeline/run.js for the
 * underlying pipeline logic these routes trigger.
 */
import express from "express";
import { supabase, logEvent, updateJob } from "../supabase.js";
import { retryJob } from "../pipeline/run.js";
import { uploadScheduled } from "../pipeline/agent5_upload.js";

export const jobsRouter = express.Router();

jobsRouter.get("/jobs", async (_req, res) => {
  const { data, error } = await supabase
    .from("pipeline_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** Videos that actually made it to YouTube — for the dashboard's Published widget. */
jobsRouter.get("/jobs/published", async (_req, res) => {
  const { data, error } = await supabase
    .from("pipeline_logs")
    .select("id, niche, title, youtube_video_id, target_region, publish_schedule, created_at")
    .not("youtube_video_id", "is", null)
    .order("publish_schedule", { ascending: false })
    .limit(24);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Manual overrides (script/title/description editing while paused)
jobsRouter.patch("/jobs/:id", async (req, res) => {
  const allowed = ["script", "title", "description", "tags", "status"];
  const patch = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  await updateJob(req.params.id, patch);
  await logEvent("Operator", `Manual override applied to job ${req.params.id.slice(0, 8)}`);
  res.json({ ok: true });
});

// Approve + upload a rendered job (used when AUTOPILOT=false)
jobsRouter.post("/jobs/:id/approve", async (req, res) => {
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
      targetChannel: job.target_channel,
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

// Retry a failed (or any) job — re-runs the pipeline fresh for its niche
jobsRouter.post("/jobs/:id/retry", async (req, res) => {
  try {
    const newJobId = await retryJob(req.params.id);
    res.json({ ok: true, newJobId, message: "Retry started" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
