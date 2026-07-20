/**
 * ROUTES: JOBS — list, manual overrides, approval, and retry for
 * individual pipeline_logs rows. See src/pipeline/run.js for the
 * underlying pipeline logic these routes trigger.
 */
import express from "express";
import { supabase, logEvent, updateJob } from "../supabase.js";
import { retryJob } from "../pipeline/run.js";
import { uploadScheduled } from "../pipeline/agent5_upload.js";
import { buildEditPayload, renderProduction } from "../pipeline/agent4_shotstack.js";
import { assertPublishableQuality, gradeContent } from "../lib/contentQuality.js";
import { config } from "../config.js";

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

// Manual overrides (title/description are safe after a render). A completed
// video's script must never be edited in place: its voiceover, captions and
// rendered timeline are already derived from the old script. Accepting that
// edit would show one story in the dashboard and publish another one.
jobsRouter.patch("/jobs/:id", async (req, res) => {
  const allowed = ["script", "title", "description", "tags", "status"];
  const patch = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: "No editable fields were supplied" });
  }

  const { data: job, error: lookupError } = await supabase
    .from("pipeline_logs")
    .select("id, script, voiceover_url, rendered_video_url, status")
    .eq("id", req.params.id)
    .single();
  if (lookupError || !job) return res.status(404).json({ error: "Job not found" });

  const scriptChanged = typeof patch.script === "string" && patch.script !== job.script;
  if (scriptChanged && (job.voiceover_url || job.rendered_video_url)) {
    return res.status(409).json({
      error: "This video has already been voiced or rendered. Script changes require a fresh run so narration, captions, and visuals remain in sync.",
      action: "retry",
    });
  }

  const { error: updateError } = await updateJob(req.params.id, patch);
  if (updateError) return res.status(500).json({ error: updateError.message });
  await logEvent("Operator", `Manual override applied to job ${req.params.id.slice(0, 8)}`);
  res.json({ ok: true });
});

// Approve + upload a rendered job (used when AUTOPILOT=false).
// Registered for GET as well as POST so the one-tap Approve button in
// Telegram notifications (a plain link) works — auth still applies via the
// global key check in index.js.
async function approveJobHandler(req, res) {
  const { data: job } = await supabase
    .from("pipeline_logs")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (!job?.rendered_video_url)
    return res.status(400).json({ error: "Job has no rendered video" });
  if (["Scheduled", "Published"].includes(job.status)) {
    return res.status(409).json({ error: "This job has already been scheduled or published." });
  }
  try {
    assertPublishableQuality(job);
    if (!job.publish_package?.platform_variants?.youtube) {
      return res.status(409).json({ error: "YouTube was not selected for this run. Use its package target instead." });
    }
    const result = await uploadScheduled({
      videoUrl: job.rendered_video_url,
      title: job.title,
      description: job.description,
      tags: job.tags,
      jobId: job.id,
      targetChannel: job.target_channel,
      niche: job.niche,
      publishPackage: job.publish_package,
    });
    await updateJob(job.id, {
      youtube_video_id: result.videoId,
      target_region: result.region,
      publish_schedule: result.publishAt.toISOString(),
      status: result.success ? "Scheduled" : "Rendered",
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
jobsRouter.post("/jobs/:id/approve", approveJobHandler);
jobsRouter.get("/jobs/:id/approve", approveJobHandler);

jobsRouter.get("/jobs/:id/publish-packages", async (req, res) => {
  const { data, error } = await supabase.from("publish_targets").select("*").eq("pipeline_log_id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

jobsRouter.post("/publish-targets/:id/mark-published", async (req, res) => {
  const externalUrl = String(req.body.external_url || "");
  if (!/^https:\/\//.test(externalUrl)) return res.status(400).json({ error: "A valid external_url is required" });
  const { error } = await supabase.from("publish_targets").update({
    status: "published",
    external_id: req.body.external_id || null,
    external_url: externalUrl,
    published_at: new Date().toISOString(),
  }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Re-render an already-approved job at full production quality (v1, no
// watermark) without re-calling OpenAI/ElevenLabs — reuses the script,
// trim points, voiceover, and music already generated and stored. Costs
// only whatever Shotstack charges for one render, since day-to-day testing
// stays on the free "stage" environment by default.
jobsRouter.post("/jobs/:id/render-production", async (req, res) => {
  const { data: job } = await supabase
    .from("pipeline_logs")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (!job?.voiceover_words || !job?.calculated_trim_points) {
    return res.status(400).json({ error: "Job is missing data needed to re-render (voiceover_words/calculated_trim_points)" });
  }
  try {
    let contentScore = Number(job.content_quality_score);
    let qualityReport = job.quality_report;
    if (!Number.isFinite(contentScore) || contentScore < config.contentQualityThreshold) {
      const review = await gradeContent({ script: job.script, title: job.title, niche: job.niche, platforms: Object.keys(job.publish_package?.platform_variants || { youtube: {} }) });
      if (!review.passed) return res.status(409).json({ error: `Legacy job failed the mandatory content gate (${review.score}/100). Retry it as a fresh run.` });
      contentScore = review.score;
      qualityReport = { overall_score: review.score, hook_score: review.hookScore, technical_pass: false, retention_prediction: `${review.score}%`, issues: [], breakdown: review.breakdown };
      await updateJob(job.id, { content_quality_score: contentScore, quality_report: qualityReport });
    }
    let cuts = job.calculated_trim_points;
    if (cuts.some((cut) => !Number.isFinite(cut.timelineStart) || !Number.isFinite(cut.timelineEnd))) {
      let cursor = 0;
      cuts = cuts.map((cut, index) => {
        const remaining = Math.max(0, Number(job.duration_seconds) - cursor);
        const length = index === cuts.length - 1 ? remaining : Math.min(remaining, Number(cut.length || 4));
        const grounded = { ...cut, timelineStart: cursor, timelineEnd: cursor + length, length };
        cursor += length;
        return grounded;
      }).filter((cut) => cut.length > 0);
    }
    const payload = buildEditPayload({
      cuts,
      voiceoverUrl: job.voiceover_url,
      words: job.voiceover_words,
      duration: job.duration_seconds,
      musicTrack: job.music_track_url ? { track_url: job.music_track_url } : null,
      preset: job.preset_snapshot || {},
      jobId: job.id,
    });
    const result = await renderProduction(payload, job.id);
    qualityReport = { ...qualityReport, overall_score: contentScore, technical_pass: true, issues: [] };
    await updateJob(job.id, {
      rendered_video_url: result.url,
      shotstack_render_id: result.renderId,
      subtitles_url: result.subtitleUrl,
      thumbnail_url: result.thumbnailUrl,
      cover_variants: result.coverVariants,
      quality_report: qualityReport,
    });
    res.json({ ok: true, url: result.url });
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
