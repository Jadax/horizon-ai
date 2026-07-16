/**
 * HORIZON AI — PIPELINE ORCHESTRATOR
 * Sequential agent execution per active niche. Called by the 03:00 UTC cron
 * (src/index.js) or manually via `npm run pipeline:once` / dashboard button.
 */
import { supabase, logEvent, updateJob } from "../supabase.js";
import { config } from "../config.js";
import { harvestTopic, harvestFootage } from "./agent1_harvester.js";
import { writeScript, calculateTrims } from "./agent2_scriptwriter.js";
import { synthesizeVoiceover, pickMusic } from "./agent3_audio.js";
import { buildEditPayload, render } from "./agent4_shotstack.js";
import { uploadScheduled } from "./agent5_upload.js";

export async function runPipelineForNiche(niche) {
  // Create the job row
  const { data: job, error } = await supabase
    .from("pipeline_logs")
    .insert({ niche: niche.niche_name, status: "Sourcing" })
    .select()
    .single();
  if (error) throw new Error(`Could not create pipeline_logs row: ${error.message}`);
  const jobId = job.id;

  try {
    // ── Agent 1: topic + licensed media ──
    const { topic, loreContext } = await harvestTopic(niche, jobId);
    const clips = await harvestFootage(niche, jobId);
    await updateJob(jobId, {
      topic: topic.title,
      source_url: topic.url,
      sourced_media_urls: clips.map((c) => ({ url: c.url, provider: c.provider, license: c.license })),
      status: "Scripting",
    });

    // ── Agent 2: script + trim points ──
    const scriptOut = await writeScript(niche, topic, loreContext, jobId);
    const preset = niche.editing_style_preset;
    const cuts = await calculateTrims(scriptOut.script, clips, preset, jobId);
    await updateJob(jobId, {
      script: scriptOut.script,
      title: scriptOut.title,
      description: scriptOut.description,
      tags: scriptOut.tags,
      calculated_trim_points: cuts,
      status: "Synthesizing",
    });

    // ── Agent 3: voiceover + music ──
    const { voiceoverUrl, words, duration } = await synthesizeVoiceover(
      scriptOut.script,
      niche.voice_profile_id,
      jobId
    );
    const musicTrack = await pickMusic(preset.music_energy, jobId);
    await updateJob(jobId, {
      voiceover_url: voiceoverUrl,
      music_track_id: musicTrack?.id || null,
      status: "Rendering",
    });

    // ── Agent 4: Shotstack render ──
    const payload = buildEditPayload({
      cuts,
      voiceoverUrl,
      words,
      duration,
      musicTrack,
      preset,
      jobId,
    });
    const { renderId, url: renderedUrl } = await render(payload, jobId);
    await updateJob(jobId, {
      shotstack_render_id: renderId,
      rendered_video_url: renderedUrl,
      status: config.autopilot ? "Rendered" : "Awaiting Approval",
    });

    // ── Agent 5: schedule + upload (autopilot only) ──
    if (config.autopilot) {
      const result = await uploadScheduled({
        videoUrl: renderedUrl,
        title: scriptOut.title,
        description: scriptOut.description,
        tags: scriptOut.tags,
        jobId,
      });
      await updateJob(jobId, {
        youtube_video_id: result.videoId,
        target_region: result.region,
        publish_schedule: result.publishAt.toISOString(),
        status: result.held ? "Rendered" : "Scheduled",
      });
    } else {
      await logEvent("Pipeline", `Autopilot OFF — job ${jobId} awaiting manual approval in dashboard`, { jobId });
    }

    await logEvent("Pipeline", `✓ ${niche.niche_name} run complete`, { jobId });
    return jobId;
  } catch (err) {
    await logEvent("Pipeline", `✗ ${niche.niche_name} failed: ${err.message}`, { jobId, level: "error" });
    await updateJob(jobId, { status: "Failed", error: err.message });
    return jobId;
  }
}

export async function runFullPipeline() {
  await logEvent("Pipeline", "═══ Daily loop started ═══");
  const { data: niches, error } = await supabase
    .from("niche_configurations")
    .select("*")
    .eq("active", true);
  if (error) throw new Error(`Could not load niches: ${error.message}`);

  for (const niche of (niches || []).slice(0, config.videosPerRun)) {
    await runPipelineForNiche(niche);
  }
  await logEvent("Pipeline", "═══ Daily loop finished ═══");
}

// Allow `npm run pipeline:once`
if (process.argv[1]?.endsWith("run.js")) {
  runFullPipeline()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
