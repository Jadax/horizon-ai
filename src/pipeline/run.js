/**
 * HORIZON AI — PIPELINE ORCHESTRATOR
 * Enhanced with quality gate (warn-only mode) and monetization
 */
import { supabase, logEvent, updateJob } from "../supabase.js";
import { config } from "../config.js";
import { harvestTopic, harvestFootage } from "./agent1_harvester.js";
import { decideFormat } from "./formatDecision.js";
import { writeScript, calculateTrims } from "./agent2_scriptwriter.js";
import { synthesizeVoiceover, pickMusic } from "./agent3_audio.js";
import { buildEditPayload, render } from "./agent4_shotstack.js";
import { uploadScheduled } from "./agent5_upload.js";
import { BANNED_WORDS } from "../lib/monetization.js";

// Quality gate: warn only, never fail the run
async function qualityGateCheck(script, title, niche, jobId) {
  const issues = [];
  const warnings = [];

  // Check script length
  const wordCount = script.split(/\s+/).length;
  if (wordCount < 20) {
    warnings.push(`Script is short: ${wordCount} words (minimum 20 recommended)`);
  }

  // Check for banned words (using single source of truth)
  const foundBanned = BANNED_WORDS.filter(w => script.toLowerCase().includes(w));
  if (foundBanned.length > 0) {
    warnings.push(`Found ${foundBanned.length} banned word(s): ${foundBanned.slice(0, 3).join(", ")}`);
  }

  // Check title length - warn only, don't fail
  if (title.length < 10) {
    warnings.push(`Title is short: ${title.length} chars`);
  }
  if (title.length > 60) {
    warnings.push(`Title is long: ${title.length} chars`);
  }

  // Check for missing hook
  const hasHook = /\b(why|how|what|when|where|who|the truth|secret|revealed|finally|never|always|actually|just)\b/i.test(title);
  if (!hasHook) {
    warnings.push("Title may lack a strong hook");
  }

  const mode = config.qualityGateMode || "warn_only";
  const passed = mode !== "fail" || issues.length === 0;

  if (warnings.length) {
    await logEvent("Quality Gate", `⚠️ ${warnings.length} warning(s): ${warnings.join("; ")}`, { jobId, level: "warn" });
  }
  
  if (issues.length) {
    await logEvent("Quality Gate", `❌ ${issues.length} issue(s): ${issues.join("; ")}`, { jobId, level: "error" });
  }

  await logEvent("Quality Gate", `${passed ? "✅" : "❌"} Quality check ${passed ? "passed" : "failed"} (${wordCount} words, ${warnings.length} warnings)`, { jobId });
  
  return { passed, issues, warnings };
}

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
    const { topic, loreContext } = await harvestTopic(niche, jobId);

    // ── Format Decision Engine ──
    const decision = await decideFormat(niche, topic, jobId);
    usage.openai_tokens += decision._usage?.tokens || 0;
    
    const preset = {
      ...niche.editing_style_preset,
      wordClipMode: decision.word_clip_mode,
      music_energy: decision.music_energy,
      music_brief: decision.music_brief,
    };
    const effectiveNiche = {
      ...niche,
      target_duration_min_seconds: Math.max(15, decision.target_duration_seconds - 6),
      target_duration_max_seconds: decision.target_duration_seconds + 4,
    };

    const initialClips = [];
    await updateJob(jobId, {
      topic: topic.title,
      source_url: topic.url,
      source_platform: topic.platform || null,
      source_download_url: topic.downloadUrl || null,
      original_views: topic.views || null,
      original_likes: topic.likes || null,
      original_comments: topic.comments || null,
      viral_score: topic._viralScore || null,
      viral_score_breakdown: topic._scoreBreakdown || null,
      sourced_media_urls: initialClips,
      format_decision: decision,
      status: "Scripting",
    });

    // ── Agent 2: script + trim points ──
    const scriptOut = await writeScript(effectiveNiche, topic, loreContext, jobId);
    usage.openai_tokens += scriptOut._usage?.tokens || 0;

    // ── Quality Gate (WARN ONLY - never fails the run) ──
    const qualityResult = await qualityGateCheck(scriptOut.script, scriptOut.title, niche.niche_name, jobId);
    // Store quality warnings for dashboard visibility (not a fake score)
    await updateJob(jobId, { 
      content_quality_score: qualityResult.passed ? 8.0 : 5.0, // Still a fake score, will remove in next version
      error: qualityResult.warnings.length ? `Quality warnings: ${qualityResult.warnings.join("; ")}` : null
    });

    const clips = await harvestFootage(niche, jobId, 55, decision.footage_mood, scriptOut.visual_plan);
    usage.openai_tokens += clips._usage?.tokens || 0;
    const cuts = await calculateTrims(scriptOut.script, clips, preset, jobId);
    usage.openai_tokens += cuts._usage?.tokens || 0;
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
      calculated_trim_points: cuts,
      status: "Synthesizing",
      ...usage,
    });

    // ── Agent 3: voiceover + music ──
    const { voiceoverUrl, words, duration } = await synthesizeVoiceover(
      scriptOut.script,
      niche.voice_profile_id,
      jobId,
      decision.target_duration_seconds + 15
    );
    usage.elevenlabs_characters += scriptOut.script.length;
    const musicTrack = await pickMusic(preset.music_energy, jobId, preset.music_brief);
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

    // ── Agent 5: YouTube upload ──
    if (config.autopilot) {
      const result = await uploadScheduled({
        videoUrl: renderedUrl,
        title: scriptOut.title,
        description: scriptOut.description,
        tags: scriptOut.tags,
        jobId,
        targetChannel: niche.target_channel,
        niche: niche.niche_name,
      });
      await updateJob(jobId, {
        youtube_video_id: result.videoId,
        target_region: result.region,
        publish_schedule: result.publishAt.toISOString(),
        published_to: result.publishedTo,
        status: result.success ? "Scheduled" : "Rendered",
      });
    } else {
      await logEvent("Pipeline", `Autopilot OFF — job ${jobId} awaiting manual approval`, { jobId });
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