/**
 * HORIZON AI — PIPELINE ORCHESTRATOR
 * Enhanced with quality gate (warn-only mode) and monetization
 */
import { supabase, logEvent, updateJob } from "../supabase.js";
import { config } from "../config.js";
import { harvestTopic, harvestFootage, resolveLoreContext } from "./agent1_harvester.js";
import { decideFormat } from "./formatDecision.js";
import { writeScript, calculateTrims } from "./agent2_scriptwriter.js";
import { synthesizeVoiceover, pickMusic } from "./agent3_audio.js";
import { buildEditPayload, render } from "./agent4_shotstack.js";
import { uploadScheduled } from "./agent5_upload.js";
import { buildPublishPackage, createPublishTargets } from "../lib/platformAdapter.js";

export async function runPipelineForNiche(niche) {
  const { data: job, error } = await supabase
    .from("pipeline_logs")
    .insert({ 
      niche: niche.niche_name, 
      status: "Sourcing", 
      target_channel: niche.target_channel || "primary" 
    })
    .select()
    .single();
  if (error) throw new Error(`Could not create pipeline_logs row: ${error.message}`);
  const jobId = job.id;
  let usage = { openai_tokens: 0, elevenlabs_characters: 0, shotstack_render_seconds: 0 };

  try {
    // ── Agent 1: topic ──
    const harvested = await harvestTopic(niche, jobId);

    // A topic with no substance fails the quality gate on every revision no
    // matter how good the writing is — so a gate failure retries with the
    // next-ranked candidate instead of failing the whole run.
    const topicQueue = [
      { topic: harvested.topic, loreContext: harvested.loreContext },
      ...(harvested.alternates || []).map((topic) => ({ topic, loreContext: undefined })),
    ];

    let topic, decision, preset, scriptOut;
    for (let i = 0; i < topicQueue.length; i++) {
      topic = topicQueue[i].topic;
      let loreContext = topicQueue[i].loreContext;
      if (loreContext === undefined) {
        loreContext = await resolveLoreContext(niche, topic.title, jobId);
      }

      // ── Format Decision Engine ──
      decision = await decideFormat(niche, topic, jobId);
      usage.openai_tokens += decision._usage?.tokens || 0;

      preset = {
        ...niche.editing_style_preset,
        wordClipMode: decision.word_clip_mode,
        // A niche can pin its music energy (editing_style_preset.musicEnergy)
        // — the per-topic format decision picked "High"-energy dance tracks
        // for calm explainer videos, where the music should always sit in the
        // same curious/light register regardless of topic.
        music_energy: niche.editing_style_preset?.musicEnergy || decision.music_energy,
        music_brief: decision.music_brief,
      };
      const effectiveNiche = {
        ...niche,
        target_duration_min_seconds: Math.max(15, decision.target_duration_seconds - 6),
        target_duration_max_seconds: decision.target_duration_seconds + 4,
      };

      await updateJob(jobId, {
        topic: topic.title,
        source_url: topic.url,
        source_platform: topic.source || topic.platform || null,
        source_download_url: null,
        original_views: topic.views || null,
        original_likes: topic.likes || null,
        original_comments: topic.comments || null,
        viral_score: topic._viralScore || null,
        viral_score_breakdown: topic._scoreBreakdown || null,
        sourced_media_urls: [],
        format_decision: decision,
        status: "Scripting",
      });

      // ── Agent 2: script + trim points ──
      try {
        scriptOut = await writeScript(effectiveNiche, topic, loreContext, jobId);
        usage.openai_tokens += scriptOut._usage?.tokens || 0;
        break;
      } catch (err) {
        if (!/quality gate/i.test(err.message) || i === topicQueue.length - 1) throw err;
        await logEvent(
          "Pipeline",
          `Topic "${topic.title.slice(0, 60)}" couldn't produce a passing script (${err.message}) — trying next candidate (${i + 2}/${topicQueue.length})`,
          { jobId, level: "warn" }
        );
      }
    }

    const qualityResult = scriptOut.quality;
    if (!qualityResult?.passed || qualityResult.score < config.contentQualityThreshold) {
      throw new Error(`Mandatory quality gate rejected script (${qualityResult?.score || 0}/100)`);
    }
    await updateJob(jobId, { 
      content_quality_score: qualityResult.score,
      quality_report: {
        overall_score: qualityResult.score,
        hook_score: qualityResult.hookScore,
        technical_pass: false,
        retention_prediction: `${qualityResult.score}%`,
        issues: [],
        breakdown: qualityResult.breakdown,
      },
      error: null,
    });

    const clips = await harvestFootage(niche, jobId, 55, decision.footage_mood, scriptOut.visual_plan);
    usage.openai_tokens += clips._usage?.tokens || 0;
    await updateJob(jobId, {
      sourced_media_urls: clips.map((c) => ({
        url: c.url, provider: c.provider, license: c.license,
        semantic_cue: c.semanticCue, visual_intent: c.visualIntent,
      })),
      script: scriptOut.script,
      title: scriptOut.title,
      title_reasoning: scriptOut.title_reasoning || null,
      title_pattern: scriptOut.title_pattern || null,
      description: scriptOut.description,
      tags: scriptOut.tags,
      status: "Synthesizing",
      ...usage,
    });

    // ── Agent 3: voiceover + music ──
    const { voiceoverUrl, words, duration, syncPrecisionMs } = await synthesizeVoiceover(
      scriptOut.script,
      niche.voice_profile_id,
      jobId,
      decision.target_duration_seconds + 15
    );
    const cuts = await calculateTrims(scriptOut.script, clips, preset, jobId, words, duration);
    usage.openai_tokens += cuts._usage?.tokens || 0;
    usage.elevenlabs_characters += scriptOut.script.length;
    const musicTrack = await pickMusic(preset.music_energy, jobId, preset.music_brief);
    await updateJob(jobId, {
      voiceover_url: voiceoverUrl,
      voiceover_words: words,
      duration_seconds: duration,
      subtitle_sync_precision_ms: syncPrecisionMs,
      calculated_trim_points: cuts,
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
    const renderResult = await render(payload, jobId);
    const { renderId, url: renderedUrl } = renderResult;
    usage.shotstack_render_seconds += Number(duration.toFixed(1));
    await updateJob(jobId, {
      shotstack_render_id: renderId,
      rendered_video_url: renderedUrl,
      subtitles_url: renderResult.subtitleUrl,
      thumbnail_url: renderResult.thumbnailUrl,
      cover_variants: renderResult.coverVariants,
      quality_report: {
        overall_score: qualityResult.score,
        hook_score: qualityResult.hookScore,
        technical_pass: true,
        retention_prediction: `${qualityResult.score}%`,
        issues: [],
        breakdown: qualityResult.breakdown,
      },
      status: config.autopilot ? "Rendered" : "Awaiting Approval",
      ...usage,
    });

    const qualityReport = {
      overall_score: qualityResult.score,
      hook_score: qualityResult.hookScore,
      technical_pass: true,
      retention_prediction: `${qualityResult.score}%`,
      issues: [],
      breakdown: qualityResult.breakdown,
    };
    const publishPackage = buildPublishPackage({
      jobId,
      niche: niche.niche_name,
      videoUrl: renderedUrl,
      subtitleUrl: renderResult.subtitleUrl,
      syncPrecisionMs,
      duration,
      title: scriptOut.title,
      description: scriptOut.description,
      tags: scriptOut.tags,
      thumbnailUrl: renderResult.thumbnailUrl,
      coverVariants: renderResult.coverVariants,
      qualityReport,
      platforms: niche.run_platforms || config.publishPlatforms,
      monetizationEnabled: niche.run_monetization ?? Boolean(config.affiliate.trackingId),
    });
    const publishTargets = createPublishTargets(publishPackage, niche.run_platforms || config.publishPlatforms);
    await updateJob(jobId, { publish_package: publishPackage });
    const { error: targetError } = await supabase.from("publish_targets").upsert(
      publishTargets.map((target) => ({ pipeline_log_id: jobId, ...target })),
      { onConflict: "pipeline_log_id,platform" }
    );
    if (targetError) throw new Error(`Could not persist publish packages: ${targetError.message}`);

    // ── Agent 5: YouTube upload ──
    if (config.autopilot && (niche.run_platforms || config.publishPlatforms).includes("youtube")) {
      const result = await uploadScheduled({
        videoUrl: renderedUrl,
        title: scriptOut.title,
        description: scriptOut.description,
        tags: scriptOut.tags,
        jobId,
        targetChannel: niche.target_channel,
        niche: niche.niche_name,
        publishPackage,
      });
      await updateJob(jobId, {
        youtube_video_id: result.videoId,
        target_region: result.region,
        publish_schedule: result.publishAt.toISOString(),
        published_to: result.publishedTo,
        status: result.success ? "Scheduled" : "Rendered",
      });
    } else if (!config.autopilot) {
      await logEvent("Pipeline", `Autopilot OFF — job ${jobId} awaiting manual approval`, { jobId });
    } else {
      await logEvent("Pipeline", `YouTube was not selected — platform packages are ready`, { jobId });
    }

    await logEvent("Pipeline", `✓ ${niche.niche_name} run complete`, { jobId });
    return jobId;
  } catch (err) {
    await logEvent("Pipeline", `✗ ${niche.niche_name} failed: ${err.message}`, { jobId, level: "error" });
    await updateJob(jobId, { status: "Failed", error: err.message });
    return jobId;
  }
}

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

if (process.argv[1]?.endsWith("run.js")) {
  runFullPipeline()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
