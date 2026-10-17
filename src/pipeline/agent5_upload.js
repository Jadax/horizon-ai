/**
 * AGENT 5 — PUBLISHER
 *
 * YouTube upload/schedule (private + publishAt) plus Instagram Reels and
 * TikTok posting when their tokens exist; unroutable platforms export as
 * publish_targets packages for manual posting.
 */
import { Readable } from "node:stream";
import { config } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { youtubeClient } from "../lib/youtubeClient.js";
import { learnedUploadHour } from "../lib/performanceTracker.js";
import { matchAffiliateProducts } from "../lib/monetization.js";
import { resolveYoutubeToken, resolveInstagramCreds, resolveTiktokCreds } from "../lib/linkedChannels.js";

const REGIONS = [
  { name: "India", tzOffset: 5.5, peakHour: 19 },
  { name: "Southeast Asia", tzOffset: 7, peakHour: 20 },
  { name: "South Africa", tzOffset: 2, peakHour: 18 },
  { name: "United States", tzOffset: -5, peakHour: 17 },
];

let regionCursor = 0;

/**
 * Publish hour resolution order: dashboard-pinned uploadHourUtc wins, then
 * the performance-tracker's learned best hour from real view data, then the
 * regional-peak rotation. Learned hours need minSamples and are cached 6h;
 * the learner never throws (returns null → rotation).
 */
async function resolvedUploadHour(fixedUtcHour, niche) {
  if (Number.isFinite(Number(fixedUtcHour)) && fixedUtcHour !== null && fixedUtcHour !== "") {
    return Number(fixedUtcHour);
  }
  try {
    return await learnedUploadHour(niche);
  } catch {
    return null;
  }
}

export function nextPublishSlot(fixedUtcHour = null) {
  // Dashboard-set per-niche upload hour (editing_style_preset.uploadHourUtc)
  // pins the publish slot instead of rotating through regional peaks.
  if (Number.isFinite(Number(fixedUtcHour)) && fixedUtcHour !== null && fixedUtcHour !== "") {
    const now = new Date();
    const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(Number(fixedUtcHour)) % 24, Math.round((Number(fixedUtcHour) % 1) * 60)));
    if (slot <= now) slot.setUTCDate(slot.getUTCDate() + 1);
    return { region: "Custom hour", publishAt: slot };
  }
  const region = REGIONS[regionCursor % REGIONS.length];
  regionCursor++;

  const now = new Date();
  let utcHour = region.peakHour - region.tzOffset;
  const slot = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  slot.setUTCMinutes(Math.round((utcHour % 1) * 60));
  slot.setUTCHours(Math.floor((utcHour + 24) % 24));
  if (slot <= now) slot.setUTCDate(slot.getUTCDate() + 1);

  return { region: region.name, publishAt: slot };
}

/**
 * Jittered retry for transient upload failures (stolen from
 * Fully-Automated-YouTube-Channel): 5xx from the API or network blips should
 * back off (capped 30s) instead of immediately failing the whole run.
 */
function isRetriable(err) {
  const code = err?.code ?? err?.response?.status ?? err?.status;
  if ([500, 502, 503, 504, 408, 429].includes(Number(code))) return true;
  return /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|EAI_AGAIN/i.test(String(err?.message || ""));
}

async function withRetry(fn, { label = "request", maxAttempts = 5 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetriable(err)) throw err;
      const wait = Math.min(30_000, Math.random() * 1000 * 2 ** (attempt - 1));
      await logEvent("Agent 5", `${label} failed (${err.message}) — retry ${attempt}/${maxAttempts - 1} in ${Math.round(wait)}ms`, { level: "warn" });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Add affiliate links to description - only if tracking ID is set
 */
async function addAffiliateLinks(description, title, niche, jobId) {
  const trackingId = config.affiliate.trackingId;
  if (!trackingId) {
    return { description, products: [] };
  }
  
  const products = matchAffiliateProducts(title, description, niche);
  
  if (!products.length) return { description, products: [] };

  let affiliateText = "\n\n---\n🛍️ **Products mentioned:**\n";
  for (const product of products) {
    affiliateText += `- ${product.name}: ${product.affiliateLink}\n`;
  }
  affiliateText += "\n*As an affiliate, I earn from qualifying purchases.*";

  return { description: description + affiliateText, products };
}

// IG/TikTok post once per job: approve re-fires uploadScheduled per YT channel,
// and an operator retry after a YT failure must not double-post the platforms
// that already went live.
async function platformAlreadyPublished(jobId, platform) {
  const { data } = await supabase
    .from("publish_targets")
    .select("id")
    .eq("pipeline_log_id", jobId)
    .eq("platform", platform)
    .eq("status", "published")
    .limit(1);
  return Boolean(data?.length);
}

export async function uploadScheduled({ videoUrl, title, description, tags, commentCta, jobId, targetChannel, niche, publishPackage }) {
  const { data: nicheRow } = niche
    ? await supabase.from("niche_configurations").select("editing_style_preset").eq("niche_name", niche).single()
    : { data: null };
  const { region, publishAt } = nextPublishSlot(await resolvedUploadHour(nicheRow?.editing_style_preset?.uploadHourUtc ?? null, niche));
  const channelKey = targetChannel || "primary";
  
  // Add affiliate links if tracking ID is set
  let finalDescription = description;
  let products = [];
  
  if (config.affiliate.trackingId) {
    const result = await addAffiliateLinks(description, title, niche, jobId);
    finalDescription = result.description;
    products = result.products;
  }

  // Store affiliate products in DB (only once)
  if (products.length) {
    await supabase
      .from('pipeline_logs')
      .update({ affiliate_products: products })
      .eq('id', jobId);
  }

  const publishedTo = [];
  let videoId = null;
  let uploadSuccess = false;

  // ── YouTube Upload (primary, fully implemented) ──────────────────────
  try {
    const token = await resolveYoutubeToken(channelKey);
    if (!token) {
      await logEvent("Agent 5", `No refresh token for channel "${channelKey}" — connect it from the dashboard's Channel Manager`, { jobId, level: "warn" });
    } else {
      await logEvent("Agent 5", `Uploading to YouTube (channel: ${channelKey})...`, { jobId });

      const videoRes = await withRetry(() => fetch(videoUrl), { label: "fetch render" });
      if (!videoRes.ok) throw new Error(`Could not fetch render: HTTP ${videoRes.status}`);

      const yt = await youtubeClient(channelKey);
      // Niche hashtags ARE the viral lever on Shorts (only the first 3 are
      // indexed in the strip). These flow from buildPublishPackage — without
      // them the upload would ship with a bare "#Shorts". Guarded so a niche
      // that already writes its own hashtags (Leo) isn't double-hashtagged.
      const pkgHashtags = (publishPackage?.metadata?.hashtags || []).slice(0, 3).join(" ");
      const alreadyHasHashtags = /#[a-z0-9_]/i.test(String(description || "") + "\n" + String(finalDescription || ""));
      const nicheHashtagBlock = pkgHashtags ? `\n\n${pkgHashtags}` : "";
      const { data } = await withRetry(
        () => yt.videos.insert({
          part: ["snippet", "status"],
          requestBody: {
            snippet: {
              title: title.slice(0, 100),
              description: `${finalDescription}${alreadyHasHashtags ? "" : nicheHashtagBlock}\n#Shorts\n\nTushant Sharma`.trim(),
              tags: (publishPackage?.platform_variants?.youtube?.tags || tags || []).slice(0, 60),
              categoryId: "24",
            },
            status: {
              privacyStatus: "private",
              publishAt: publishAt.toISOString(),
              selfDeclaredMadeForKids: false,
              containsSyntheticMedia: true,
            },
          },
          media: { body: Readable.fromWeb(videoRes.body) },
        }),
        { label: "YouTube insert" }
      );

      videoId = data.id;

      // Custom thumbnail (stolen from growth-tools repo): YouTube only needs
      // the source image once — it generates the maxresdefault/sddefault/
      // hqdefault/mqdefault/default set automatically. Best-effort: a
      // thumbnail failure must not fail the scheduled upload.
      try {
        const thumbUrl = publishPackage?.video?.thumbnailUrl || publishPackage?.video?.coverVariants?.[0] || null;
        if (thumbUrl) {
          const thumbRes = await fetch(thumbUrl);
          if (thumbRes.ok) {
            await withRetry(
              () => yt.thumbnails.set({ videoId, media: { body: Readable.fromWeb(thumbRes.body) } }),
              { label: "thumbnail set" }
            );
            await logEvent("Agent 5", `✓ Custom thumbnail set: ${videoId}`, { jobId });
          }
        }
      } catch (thumbErr) {
        await logEvent("Agent 5", `Custom thumbnail failed (non-fatal): ${thumbErr.message}`, { jobId, level: "warn" });
      }

      // Pinned-comment comment-velocity CTA (stolen from clipforge's
      // interactionGuide): a designed, on-topic question seeded on the video
      // manufactures the comments-velocity signal platforms reward. Best-effort
      // — pinned comments only stick once the video is live, so at schedule
      // time this is a seed; failures are non-fatal.
      try {
        if (commentCta) {
          const pinBody = typeof commentCta === "string" && commentCta.trim() ? commentCta.trim() : null;
          if (pinBody) {
            const commentRes = await withRetry(
              () => yt.commentThreads.insert({
                part: ["snippet"],
                requestBody: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: pinBody.slice(0, 500) } } } },
              }),
              { label: "comment insert", maxAttempts: 2 }
            );
            if (commentRes?.data?.id) {
              await logEvent("Agent 5", `✓ Comment CTA seeded on ${videoId}: "${pinBody.slice(0, 80)}"`, { jobId });
            }
          }
        }
      } catch (commentErr) {
        await logEvent("Agent 5", `Comment CTA failed (non-fatal): ${commentErr.message}`, { jobId, level: "warn" });
      }
      publishedTo.push({ platform: 'youtube', videoId: data.id, status: 'scheduled' });
      // Multi-channel fan-out: (pipeline_log_id, platform) is the upsert key,
      // so a second channel's upload would silently overwrite the first
      // channel's external_id. Preserve every channel's record in
      // package.youtube_targets and keep the row's external_id pinned to the
      // first scheduled video.
      const { data: existingYt } = await supabase
        .from("publish_targets")
        .select("external_id, scheduled_at, package")
        .eq("pipeline_log_id", jobId)
        .eq("platform", "youtube")
        .maybeSingle();
      const ytTargetRecord = { channel: channelKey, videoId: data.id, scheduled_at: publishAt.toISOString() };
      const prevTargets = (existingYt?.package?.youtube_targets || []).filter((t) => t.channel !== channelKey);
      const keptExternalId = existingYt?.external_id || data.id;
      const keptScheduledAt = existingYt?.external_id ? existingYt.scheduled_at : publishAt.toISOString();
      await supabase.from("publish_targets").upsert({
        pipeline_log_id: jobId,
        platform: "youtube",
        mode: "direct",
        status: "scheduled",
        package: {
          ...(publishPackage ? {
            video: publishPackage.video,
            subtitles: publishPackage.subtitles,
            metadata: publishPackage.metadata,
            variant: publishPackage.platform_variants?.youtube || {},
            monetization: publishPackage.monetization,
          } : {}),
          youtube_targets: [...prevTargets, ytTargetRecord],
        },
        external_id: keptExternalId,
        scheduled_at: keptScheduledAt,
      }, { onConflict: "pipeline_log_id,platform" });
      uploadSuccess = true;
      await logEvent("Agent 5", `✓ YouTube scheduled: ${data.id} → ${region}`, { jobId });
    }
  } catch (err) {
    await logEvent("Agent 5", `YouTube upload failed: ${err.message}`, { jobId, level: "error" });
    // YouTube upload failed - don't mark as scheduled
  }

  // ── Instagram Reels (Graph API) — per-niche channel first (dashboard-linked
  // or legacy env), falling back to the single global account ──
  const igChannelKey = nicheRow?.editing_style_preset?.targetInstagramChannels?.[0] || null;
  const igCreds = await resolveInstagramCreds(igChannelKey);
  const igAlreadyLive = await platformAlreadyPublished(jobId, "instagram");
  if (igAlreadyLive) {
    await logEvent("Agent 5", "Instagram already published for this job — skipping duplicate re-post", { jobId });
  }
  if (igCreds?.accessToken && igCreds?.businessId && !igAlreadyLive) {
    try {
      await logEvent("Agent 5", `Uploading to Instagram Reels (channel: ${igChannelKey || "primary"})...`, { jobId });
      const igVariant = publishPackage?.platform_variants?.instagram || {};
      const caption = igVariant.caption || `${title}\n\n${(description || "").slice(0, 300)}`;
      const igResult = await uploadToInstagram({
        videoUrl,
        caption: caption.slice(0, 2200),
        businessId: igCreds.businessId,
        accessToken: igCreds.accessToken,
      });
      publishedTo.push({ platform: "instagram", mediaId: igResult.id, status: "published" });
      await supabase.from("publish_targets").upsert({
        pipeline_log_id: jobId,
        platform: "instagram",
        mode: "direct",
        status: "published",
        package: {
          video: publishPackage?.video,
          subtitles: publishPackage?.subtitles,
          metadata: publishPackage?.metadata,
          variant: igVariant,
          monetization: publishPackage?.monetization,
        },
        external_id: igResult.id,
        external_url: igResult.permalink || null,
        published_at: new Date().toISOString(),
      }, { onConflict: "pipeline_log_id,platform" });
      await logEvent("Agent 5", `✓ Instagram Reel published: ${igResult.id}`, { jobId });
    } catch (err) {
      await logEvent("Agent 5", `Instagram upload failed: ${err.message}`, { jobId, level: "error" });
    }
  }

  // ── TikTok (Content Posting API) — per-niche channel first, then the
  // single global account. Still requires an approved TikTok app either way. ──
  const ttChannelKey = nicheRow?.editing_style_preset?.targetTiktokChannels?.[0] || null;
  const ttCreds = await resolveTiktokCreds(ttChannelKey);
  const ttAlreadyLive = await platformAlreadyPublished(jobId, "tiktok");
  if (ttAlreadyLive) {
    await logEvent("Agent 5", "TikTok already published for this job — skipping duplicate re-post", { jobId });
  }
  if (ttCreds?.accessToken && !ttAlreadyLive) {
    try {
      await logEvent("Agent 5", `Uploading to TikTok (channel: ${ttChannelKey || "primary"})...`, { jobId });
      const ttVariant = publishPackage?.platform_variants?.tiktok || {};
      const ttResult = await uploadToTikTok({
        videoUrl,
        title: (ttVariant.caption || title || "").slice(0, 150),
        accessToken: ttCreds.accessToken,
      });
      publishedTo.push({ platform: "tiktok", externalId: ttResult.share_url, status: "published" });
      await supabase.from("publish_targets").upsert({
        pipeline_log_id: jobId,
        platform: "tiktok",
        mode: "direct",
        status: "published",
        package: {
          video: publishPackage?.video,
          subtitles: publishPackage?.subtitles,
          metadata: publishPackage?.metadata,
          variant: ttVariant,
          monetization: publishPackage?.monetization,
        },
        external_id: ttResult.share_url || null,
        external_url: ttResult.share_url || null,
        published_at: new Date().toISOString(),
      }, { onConflict: "pipeline_log_id,platform" });
      await logEvent("Agent 5", `✓ TikTok published: ${ttResult.share_url}`, { jobId });
    } catch (err) {
      await logEvent("Agent 5", `TikTok upload failed: ${err.message}`, { jobId, level: "error" });
    }
  }

  // Update job - status reflects REAL uploads only
  const status = uploadSuccess ? "Scheduled" : "Rendered";

  await supabase
    .from('pipeline_logs')
    .update({
      youtube_video_id: videoId,
      target_region: region,
      publish_schedule: uploadSuccess ? publishAt.toISOString() : null,
      published_to: publishedTo,
      affiliate_products: products,
      status: status,
    })
    .eq('id', jobId);

  await logEvent("Agent 5", `✓ YouTube ${uploadSuccess ? 'scheduled' : 'upload failed'}`, { jobId });
  return { region, publishAt, publishedTo, videoId, success: uploadSuccess };
}

/**
 * Upload a video as an Instagram Reel via the Graph API.
 * Flow: POST /{business-id}/media (create container) → poll status → POST /{business-id}/media_publish
 * Requires: INSTAGRAM_ACCESS_TOKEN (long-lived) + INSTAGRAM_BUSINESS_ID (IG Business/Creator account).
 * The video URL must be publicly accessible (Supabase storage URLs qualify).
 */
async function uploadToInstagram({ videoUrl, caption, businessId, accessToken }) {
  const baseUrl = `https://graph.facebook.com/v21.0/${businessId}`;

  // Step 1: Create a REELS media container
  const containerRes = await fetch(`${baseUrl}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: "REELS",
      video_url: videoUrl,
      caption: caption.slice(0, 2200),
      share_to_feed: true,
      access_token: accessToken,
    }),
  });
  const containerData = await containerRes.json();
  if (containerData.error) throw new Error(`IG container creation failed: ${containerData.error.message}`);
  const containerId = containerData.id;

  // Step 2: Poll until container is ready (max 5 min, 10s intervals)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const statusRes = await fetch(`${baseUrl}/${containerId}?fields=status_code,status&access_token=${accessToken}`);
    const statusData = await statusRes.json();
    if (statusData.error) throw new Error(`IG status check failed: ${statusData.error.message}`);
    if (statusData.status_code === "FINISHED") break;
    if (statusData.status_code === "ERROR") throw new Error(`IG container processing failed: ${JSON.stringify(statusData)}`);
    if (i === 29) throw new Error("IG container processing timed out (5 min)");
  }

  // Step 3: Publish
  const publishRes = await fetch(`${baseUrl}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      creation_id: containerId,
      access_token: accessToken,
    }),
  });
  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(`IG publish failed: ${publishData.error.message}`);

  return { id: publishData.id, permalink: null };
}

/**
 * Upload a video via TikTok's Content Posting API.
 * Flow: POST /v2/post/publish/video/init/ → upload to returned URL → POST /v2/post/publish/video/complete/
 * Requires: TIKTOK_ACCESS_TOKEN from an approved TikTok for Developers app (video.upload scope).
 * The video URL must be publicly accessible. Max file size: 500MB.
 */
async function uploadToTikTok({ videoUrl, title, accessToken }) {
  const baseUrl = "https://open.tiktokapis.com/v2";

  // Step 1: Initialize upload — get a upload URL + upload token
  const initRes = await fetch(`${baseUrl}/post/publish/video/init/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      post_info: { title: title.slice(0, 150), privacy_level: "PUBLIC_TO_EVERYONE" },
      source_info: { source: "URL", video_url: videoUrl },
    }),
  });
  const initData = await initRes.json();
  // When source=URL, TikTok processes the video directly — no separate upload
  // step needed; the publish_id is returned for polling.
  const publishId = initData.data?.publish_id;
  if (!publishId) throw new Error(`TikTok init failed: ${JSON.stringify(initData.error || initData)}`);

  // Step 2: Poll status until published (max 5 min, 10s intervals)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const statusRes = await fetch(`${baseUrl}/post/publish/status/fetch/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const statusData = await statusRes.json();
    if (statusData.error?.code !== "ok") throw new Error(`TikTok status check failed: ${JSON.stringify(statusData.error)}`);
    const status = statusData.data?.status;
    if (status === "PUBLISH_SUCCESS") {
      return { share_url: statusData.data?.share_url || null, publish_id: publishId };
    }
    if (status === "PUBLISH_FAILED") throw new Error(`TikTok publish failed: ${statusData.data?.fail_reason || "unknown"}`);
    if (i === 29) throw new Error("TikTok publish timed out (5 min)");
  }
  throw new Error("TikTok publish loop exited unexpectedly");
}
