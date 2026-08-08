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
import { VOICE_BY_NICHE } from "../lib/viralScience.js";
import { complianceScan } from "../lib/compliance.js";
import { notifyAwaitingApproval } from "../lib/telegram.js";

// ─── PER-NICHE RUNTIME DEFAULTS ─────────────────────────────────────────
// Research-backed out-of-the-box differentiation: every niche gets its film
// look + caption texture + vibe without waiting for a dashboard edit. These
// fill gaps only — a value the user has set (dashboard or API) always wins.
// color_preset is deliberately NOT set here: formatDecision already picks the
// niche-appropriate film look per topic.
const NICHE_FILM_DEFAULTS = [
  { match: /pet|cat|dog|animal|kitten|puppy|leo/i, caption: { color: "cream", fontsize: 68, style: "warm" }, musicEnergy: "Chill", petMode: true },
  { match: /tech|ai|programming|coding|science|space|gadget/i, caption: { color: "white", fontsize: 60, style: "geometric" } },
  { match: /food|recipe|cook|baking|restaurant/i, caption: { color: "white", fontsize: 62, style: "rounded" } },
  { match: /motivat|self.?improve|discipline|mindset|success|fitness|gym/i, caption: { color: "white", fontsize: 64, style: "impact" } },
  { match: /finance|money|invest|stock|bitcoin|crypto|trading|business|entrepreneur/i, caption: { color: "yellow", fontsize: 60, style: "geometric" } },
  { match: /game|gaming|esport|twitch/i, caption: { color: "sky", fontsize: 60, style: "geometric" } },
  { match: /histor|explain|learn|education|documentary|facts|know/i, caption: { color: "cream", fontsize: 60, style: "documentary" } },
  { match: /travel|adventure|nature|outdoor|wander/i, caption: { color: "white", fontsize: 60, style: "minimal" } },
  { match: /entertain|funny|comedy|news|celebrity|movie|tv/i, caption: { color: "yellow", fontsize: 62, style: "impact" } },
];

function applyNicheDefaults(basePreset, nicheName) {
  const entry = NICHE_FILM_DEFAULTS.find((d) => d.match.test(nicheName || ""));
  if (!entry) return basePreset;
  const out = { ...basePreset };
  if (entry.caption) {
    out.caption = { ...(out.caption || {}), ...entry.caption };
  }
  if (entry.musicEnergy && out.musicEnergy === undefined) out.musicEnergy = entry.musicEnergy;
  if (entry.petMode && out.petMode === undefined) out.petMode = true;
  return out;
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
  // Legacy cost-tracker columns (kept for the dashboard's legacy estimate —
  // now tracking Gemini token counts, voiceover chars, and render seconds).
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

    let topic, decision, preset, scriptOut, clips;
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
        ...applyNicheDefaults(niche.editing_style_preset || {}, niche.niche_name || ""),
        wordClipMode: decision.word_clip_mode,
        // Loop-mode matches agent2's rule (maxSeconds <= 70 → loop ending):
        // enables the visual soft-loop outro (tail echoes the frame-1 hook).
        loopMode: decision.target_duration_seconds + 4 <= 70,
        // A niche can pin its music energy (editing_style_preset.musicEnergy)
        // — the per-topic format decision picked "High"-energy dance tracks
        // for calm explainer videos, where the music should always sit in the
        // same curious/light register regardless of topic.
        music_energy: niche.editing_style_preset?.musicEnergy || decision.music_energy,
        music_brief: decision.music_brief,
        color_preset: decision.color_preset || "classic_white",
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
        sourced_media_urls: [],
        format_decision: decision,
        status: "Scripting",
      });

      // ── Agent 2: script + trim points ──
      try {
        scriptOut = await writeScript(effectiveNiche, topic, loreContext, jobId);
        usage.openai_tokens += scriptOut._usage?.tokens || 0;
        clips = await harvestFootage(niche, jobId, 55, decision.footage_mood, scriptOut.visual_plan);
        usage.openai_tokens += clips._usage?.tokens || 0;
        break;
      } catch (err) {
        const retryable = /quality gate|visually verified footage|visual QA|footage coverage/i.test(err.message);
        if (!retryable || i === topicQueue.length - 1) throw err;
        await logEvent(
          "Pipeline",
          `Topic "${topic.title.slice(0, 60)}" couldn't produce a passing script (${err.message}) — trying next candidate (${i + 2}/${topicQueue.length})`,
          { jobId, level: "warn" }
        );
      }
    }

    const qualityResult = scriptOut.quality;
    // LLM-selected hook headline + emphasis words flow into the render preset:
    // hook_text becomes the frame-1 on-screen hook overlay, emphasis_words get
    // yellow-highlighted in the captions (Submagic/OpusClip/Hormozi steal).
    preset.hookText = scriptOut.hook_text || null;
    preset.caption = {
      ...(preset.caption || {}),
      ...(Array.isArray(scriptOut.emphasis_words) && scriptOut.emphasis_words.length
        ? { emphasis: scriptOut.emphasis_words.filter((w) => typeof w === "string" && w.trim()).slice(0, 6) }
        : {}),
    };
    const nicheThreshold = Number(niche.editing_style_preset?.qualityThreshold) || config.contentQualityThreshold;
    if (!qualityResult?.passed || qualityResult.score < nicheThreshold) {
      throw new Error(`Mandatory quality gate rejected script (${qualityResult?.score || 0}/100)`);
    }
    // Compliance gate (stolen from clipforge ad-law scanner): deterministic
    // medical/financial claim check runs BEFORE we spend a single render/upload
    // second — a hard-flag (e.g. "cures", "guaranteed income") would get the
    // video demonetized or struck. Hard flags kill the topic; soft flags are
    // logged for the next rewrite.
    const compliance = complianceScan(scriptOut.title || "", scriptOut.description || "", scriptOut.script || "");
    if (compliance.blocking.length) {
      throw new Error(`Compliance gate blocked script (${compliance.blocking.map((b) => `${b.label}:"${b.match}"`).join(", ")})`);
    }
    if (compliance.warnings.length) {
      await logEvent("Pipeline", `Compliance soft-flags: ${compliance.warnings.map((w) => `${w.label}:"${w.match}"`).join(", ")}`, { jobId, level: "warn" });
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

    // SEO split (stolen from Fully-Automated-YouTube-Channel): agent2 embeds
    // title_keywords (the top search terms people actually use) in the title —
    // merge them into the upload tags so the title keywords rank as tags too.
    const uploadTags = [...new Set([...(scriptOut.title_keywords || []), ...(scriptOut.tags || [])])];

    // ── Agent 3: voiceover + music ──
    // Top-creator voice matching: prefer the niche's pinned Gemini voice
    // (editing_style_preset.geminiVoice), then the research-backed table,
    // then the legacy voice_profile_id. voice_profile_id holds ElevenLabs
    // IDs that silently fell back to a single Gemini voice for every niche.
    const geminiVoice =
      preset.geminiVoice ||
      VOICE_BY_NICHE[niche.niche_name] ||
      niche.voice_profile_id ||
      null;
    const { voiceoverUrl, words, duration, syncPrecisionMs } = await synthesizeVoiceover(
      scriptOut.script,
      geminiVoice,
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
    const payload = await buildEditPayload({
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
      tags: uploadTags,
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

    // ── Agent 5: upload (YouTube multi-channel fan-out + IG/TT auto-post) ──
    if (config.autopilot) {
      const platforms = niche.run_platforms || config.publishPlatforms;
      const hasYt = platforms.includes("youtube");
      const results = [];

      // YouTube: multi-channel fan-out
      if (hasYt) {
        const preset = niche.editing_style_preset || {};
        const channels = Array.isArray(preset.targetChannels) && preset.targetChannels.length
          ? preset.targetChannels
          : [niche.target_channel || "primary"];
        for (const channel of channels) {
          const result = await uploadScheduled({
            videoUrl: renderedUrl,
            title: scriptOut.title,
            description: scriptOut.description,
            tags: uploadTags,
            commentCta: scriptOut.interactionGuide || null,
            jobId,
            targetChannel: channel,
            niche: niche.niche_name,
            publishPackage,
          });
          results.push({ channel, result });
        }
      }

      // Instagram / TikTok: uploadScheduled handles these internally
      // when their tokens are configured — fire once if not already done via YT
      if (!hasYt && (config.instagram.accessToken || config.tiktok.accessToken)) {
        const result = await uploadScheduled({
          videoUrl: renderedUrl,
          title: scriptOut.title,
          description: scriptOut.description,
          tags: scriptOut.tags,
          commentCta: scriptOut.interactionGuide || null,
          jobId,
          targetChannel: "primary",
          niche: niche.niche_name,
          publishPackage,
        });
        results.push({ channel: "primary", result });
      }

      const primary = results[0];
      await updateJob(jobId, {
        youtube_video_id: primary?.result?.videoId || null,
        target_region: primary?.result?.region,
        publish_schedule: primary?.result?.publishAt?.toISOString(),
        published_to: results.map((r) => ({ channel: r.channel, videoId: r.result?.videoId })),
        status: primary?.result?.success ? "Scheduled" : "Rendered",
      });
    } else {
      await logEvent("Pipeline", `Autopilot OFF — job ${jobId} awaiting manual approval`, { jobId });
      await notifyAwaitingApproval({
        jobId,
        title: scriptOut.title,
        score: qualityResult.score,
        duration,
        videoUrl: renderedUrl,
      });
    }

    // A/B variant matrix (opt-in via preset.variants) — re-render cheap
    // hook/caption variants of the winner and post them for empirical testing.
    if (preset.variants) {
      await runVariantShorts({ niche, jobId, preset, payload, words, duration, syncPrecisionMs, uploadTags, scriptOut, qualityResult }).catch((e) =>
        logEvent("Pipeline", `Variant A/B run skipped (non-fatal): ${e.message}`, { jobId, level: "warn" })
      );
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
    // Local-folder niches (Leo: `npm run leo:sync` processes leo_inbox/ on
    // the operator's machine, not Railway) opt out of the standard
    // RSS/Reddit topic-harvest pipeline entirely via editing_style_preset
    // .localFolder — harvestTopic() would otherwise throw "No topic
    // candidates found" and burn a Failed job every cadence cycle.
    if (niche.editing_style_preset?.localFolder) {
      await logEvent("Scheduler", `${niche.niche_name}: local-folder niche — runs via its own sync command, not the daily loop`);
      continue;
    }
    // Defensive net: a niche with zero configured sources AND no reliance
    // on the always-on global trending pool (google/wikipedia_trending/
    // hackernews/bluesky/gdelt) can never produce a candidate either.
    const globalOnly = new Set(["google", "wikipedia_trending", "hackernews", "bluesky", "gdelt"]);
    const restrictedToGlobal = Array.isArray(niche.editing_style_preset?.trendSources) &&
      niche.editing_style_preset.trendSources.every((s) => !globalOnly.has(s));
    const hasCustomSources = niche.rss_feeds?.length || niche.target_sources?.length ||
      niche.mastodon_tags?.length || niche.lemmy_communities?.length || niche.social_rss_feeds?.length;
    if (!hasCustomSources && restrictedToGlobal) {
      await logEvent("Scheduler", `${niche.niche_name}: no topic sources configured — skipping instead of a doomed run`, { level: "warn" });
      continue;
    }
    // Per-niche cadence (editing_style_preset.cadenceDays, dashboard-set):
    // skip a niche whose last successful job is more recent than its cadence
    // window, so e.g. Leo can post daily while a niche rests at every 3 days.
    const cadenceDays = Number(niche.editing_style_preset?.cadenceDays) || 1;
    if (cadenceDays > 1) {
      const cutoff = new Date(Date.now() - (cadenceDays - 0.5) * 24 * 60 * 60 * 1000).toISOString();
      const { data: recent } = await supabase
        .from("pipeline_logs")
        .select("id")
        .eq("niche", niche.niche_name)
        .neq("status", "Failed")
        .gte("created_at", cutoff)
        .limit(1);
      if (recent?.length) {
        await logEvent("Scheduler", `${niche.niche_name}: within its ${cadenceDays}-day cadence window — skipping today`);
        continue;
      }
    }
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

/**
 * VARIANT A/B (stolen from MoneyPrinterTurbo + clipforge's variant matrix):
 * after the primary short is published, re-render the SAME content as N-1
 * cheap variants that A/B the two biggest CTR/retention levers — the first
 * 3-second hook text and the caption treatment (punch-card vs word-clip) —
 * then post each as its own Short on the same channel. Zero extra LLM/TTS
 * cost (only re-render). YouTube treats these as distinct videos, so the
 * closed-loop learner's title_pattern grouping naturally reveals which hook
 * won. The earlier archives showed "guaranteed virality" is really empirical:
 * testing 3 hooks on the best topic beats guessing one.
 *
 * Config lives in the existing editing_style_preset.variants jsonb (no new
 * column): either a NUMBER (N = total variants incl. the primary, cheap
 * caption-style cycle) or an ARRAY of {style?, color?, hook?, title?}.
 * Opt-in only; failures are non-fatal (a variant never breaks the main job).
 */
function variantList(preset, baseTitle) {
  const v = preset.variants;
  if (!v) return [];
  if (Array.isArray(v)) return v.slice(0, 3);
  if (Number.isFinite(Number(v))) {
    const count = Math.max(2, Math.min(4, Math.floor(Number(v))));
    const styles = ["punch", "wordclip"];
    const list = [];
    for (let i = 1; i < count; i++) {
      list.push({ style: styles[(i - 1) % styles.length], title: `${baseTitle} #${i}` });
    }
    return list;
  }
  return [];
}

async function runVariantShorts({ niche, jobId, preset, payload, words, duration, syncPrecisionMs, uploadTags, scriptOut, qualityResult }) {
  const variants = variantList(preset, scriptOut.title);
  if (!variants.length) return;
  const primaryChannel = Array.isArray(preset.targetChannels) && preset.targetChannels.length
    ? preset.targetChannels[0]
    : (niche.target_channel || "primary");

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    try {
      const vPayload = structuredClone(payload);
      if (variant.style) vPayload.captionStyle = { ...(vPayload.captionStyle || {}), style: variant.style };
      if (variant.color) vPayload.captionStyle = { ...(vPayload.captionStyle || {}), color: variant.color };
      if (variant.hook && Array.isArray(vPayload.overlays) && vPayload.overlays.length) {
        vPayload.overlays[0] = { ...vPayload.overlays[0], text: String(variant.hook).slice(0, 40) };
      }

      const { data: child, error: cErr } = await supabase
        .from("pipeline_logs")
        .insert({ niche: niche.niche_name, status: "Rendering", target_channel: primaryChannel, topic: `variant ${i + 2} of ${jobId}` })
        .select()
        .single();
      if (cErr || !child) throw new Error(`Variant row creation failed: ${cErr?.message || "no row"}`);
      const vJobId = child.id;

      const renderResult = await render(vPayload, vJobId);
      const vTitle = variant.title || `${scriptOut.title} #${i + 2}`;
      const vPackage = buildPublishPackage({
        jobId: vJobId,
        niche: niche.niche_name,
        videoUrl: renderResult.url,
        subtitleUrl: renderResult.subtitleUrl,
        syncPrecisionMs,
        duration,
        title: vTitle,
        description: scriptOut.description,
        tags: uploadTags,
        thumbnailUrl: renderResult.thumbnailUrl,
        coverVariants: renderResult.coverVariants,
        qualityReport: {
          overall_score: qualityResult.score,
          hook_score: qualityResult.hookScore,
          technical_pass: true,
          retention_prediction: `${qualityResult.score}%`,
          issues: [],
          breakdown: qualityResult.breakdown,
        },
        platforms: ["youtube"],
        monetizationEnabled: niche.run_monetization ?? Boolean(config.affiliate.trackingId),
      });
      vPackage.variant_group = jobId; // lineage so the learner can compare A/B arms
      vPackage.variant_index = i + 2;
      vPackage.variant_style = variant.style || "n/a";

      if (config.autopilot) {
        const up = await uploadScheduled({
          videoUrl: renderResult.url,
          title: vTitle,
          description: scriptOut.description,
          tags: uploadTags,
          commentCta: scriptOut.interactionGuide || null,
          jobId: vJobId,
          targetChannel: primaryChannel,
          niche: niche.niche_name,
          publishPackage: vPackage,
        });
        await updateJob(vJobId, {
          rendered_video_url: renderResult.url,
          publish_package: vPackage,
          youtube_video_id: up?.videoId || null,
          publish_schedule: up?.publishAt?.toISOString(),
          status: up?.success ? "Scheduled" : "Rendered",
        });
      } else {
        await updateJob(vJobId, { rendered_video_url: renderResult.url, publish_package: vPackage, status: "Awaiting Approval" });
      }
      await logEvent("Pipeline", `✓ A/B variant ${i + 2}/${variants.length + 1} rendered${config.autopilot ? " + scheduled" : ""}: "${vTitle}"`, { jobId });
    } catch (err) {
      await logEvent("Pipeline", `A/B variant ${i + 2} skipped (non-fatal): ${err.message}`, { jobId, level: "warn" });
    }
  }
}
