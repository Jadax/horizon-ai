/**
 * HORIZON AI — PIPELINE ORCHESTRATOR
 * Sequential agent execution per active niche. Called by the 03:00 UTC cron
 * (src/index.js) or manually via `npm run pipeline:once` / dashboard button.
 */
import { supabase, logEvent, updateJob } from "../supabase.js";
import { config } from "../config.js";
import { harvestTopic, harvestFootage } from "./agent1_harvester.js";
import { decideFormat } from "./formatDecision.js";
import { writeScript, calculateTrims } from "./agent2_scriptwriter.js";
import { synthesizeVoiceover, pickMusic } from "./agent3_audio.js";
import { buildEditPayload, render } from "./agent4_shotstack.js";
import { uploadScheduled } from "./agent5_upload.js";

export async function runPipelineForNiche(niche) {
  // Create the job row
  const { data: job, error } = await supabase
    .from("pipeline_logs")
    .insert({ niche: niche.niche_name, status: "Sourcing", target_channel: niche.target_channel || "primary" })
    .select()
    .single();
  if (error) throw new Error(`Could not create pipeline_logs row: ${error.message}`);
  const jobId = job.id;
  let usage = { openai_tokens: 0, elevenlabs_characters: 0, shotstack_render_seconds: 0 };

  try {
    // ── Agent 1: topic ──
    const { topic, loreContext } = await harvestTopic(niche, jobId);

    // ── Format Decision Engine: how should THIS topic be presented? ──
    const decision = await decideFormat(niche, topic, jobId);
    usage.openai_tokens += decision._usage?.tokens || 0;
    // Effective preset/duration for the rest of this run — the niche's
    // config is still the outer boundary, but every generation step below
    // uses the per-topic decision, not the niche's static default.
    const preset = { ...niche.editing_style_preset, wordClipMode: decision.word_clip_mode, music_energy: decision.music_energy };
    const effectiveNiche = {
      ...niche,
      target_duration_min_seconds: Math.max(15, decision.target_duration_seconds - 6),
      target_duration_max_seconds: decision.target_duration_seconds + 4,
    };

    // ── Agent 1 continued: licensed footage, mood-matched to the decision ──
    const clips = await harvestFootage(niche, jobId, 55, decision.footage_mood);
    await updateJob(jobId, {
      topic: topic.title,
      source_url: topic.url,
      sourced_media_urls: clips.map((c) => ({ url: c.url, provider: c.provider, license: c.license })),
      format_decision: decision,
      status: "Scripting",
    });

    // ── Agent 2: script + trim points ──
    const scriptOut = await writeScript(effectiveNiche, topic, loreContext, jobId);
    usage.openai_tokens += scriptOut._usage?.tokens || 0;
    const cuts = await calculateTrims(scriptOut.script, clips, preset, jobId);
    usage.openai_tokens += cuts._usage?.tokens || 0;
    await updateJob(jobId, {
      script: scriptOut.script,
      title: scriptOut.title,
      title_reasoning: scriptOut.title_reasoning || null,
      description: scriptOut.description,
      tags: scriptOut.tags,
      calculated_trim_points: cuts,
      status: "Synthesizing",
      ...usage,
    });

    // ── Agent 3: voiceover + music ──
    const { voiceoverUrl, words, duration } = await synthesizeVoiceover(
      scriptOut.script,
      niche.voice_profile_id,
      jobId,
      decision.target_duration_seconds + 15 // small buffer before warning fires
    );
    usage.elevenlabs_characters += scriptOut.script.length;
    const musicTrack = await pickMusic(preset.music_energy, jobId);
    await updateJob(jobId, {
      voiceover_url: voiceoverUrl,
      voiceover_words: words,
      duration_seconds: duration,
      music_track_id: musicTrack?.id || null,
      music_track_url: musicTrack?.track_url || null,
      preset_snapshot: preset,
      status: "Rendering",
      ...usage,
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
    usage.shotstack_render_seconds += Number((duration + 1.5).toFixed(1));
    await updateJob(jobId, {
      shotstack_render_id: renderId,
      rendered_video_url: renderedUrl,
      status: config.autopilot ? "Rendered" : "Awaiting Approval",
      ...usage,
    });

    // ── Agent 5: schedule + upload (autopilot only) ──
    if (config.autopilot) {
      const result = await uploadScheduled({
        videoUrl: renderedUrl,
        title: scriptOut.title,
        description: scriptOut.description,
        tags: scriptOut.tags,
        jobId,
        targetChannel: niche.target_channel,
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

/** Re-run the pipeline for the same niche as a failed (or any) job. */
export async function retryJob(jobId) {
  const { data: job, error } = await supabase
    .from("pipeline_logs")
    .select("niche")
    .eq("id", jobId)
    .single();
  if (error || !job) throw new Error("Original job not found");

  const { data: niche, error: nErr } = await supabase
    .from("niche_configurations")
    .select("*")
    .eq("niche_name", job.niche)
    .single();
  if (nErr || !niche) throw new Error(`Niche "${job.niche}" not found or inactive`);

  await logEvent("Operator", `Retrying failed job as a fresh run for ${niche.niche_name}`);
  return runPipelineForNiche(niche);
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
