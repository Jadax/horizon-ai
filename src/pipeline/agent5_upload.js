/**
 * AGENT 5 — YOUTUBE UPLOADER
 * 
 * Focused on YouTube only - the platform with real implementation.
 * Other platforms (Instagram, Facebook, TikTok) are stubs for future.
 */
import { google } from "googleapis";
import { Readable } from "node:stream";
import { config, getChannelToken } from "../config.js";
import { supabase, logEvent } from "../supabase.js";
import { matchAffiliateProducts } from "../lib/monetization.js";

const REGIONS = [
  { name: "India", tzOffset: 5.5, peakHour: 19 },
  { name: "Southeast Asia", tzOffset: 7, peakHour: 20 },
  { name: "South Africa", tzOffset: 2, peakHour: 18 },
  { name: "United States", tzOffset: -5, peakHour: 17 },
];

let regionCursor = 0;

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

function youtubeClient(channelKey) {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  oauth2.setCredentials({ refresh_token: getChannelToken(channelKey) });
  return google.youtube({ version: "v3", auth: oauth2 });
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

export async function uploadScheduled({ videoUrl, title, description, tags, jobId, targetChannel, niche, publishPackage }) {
  const { data: nicheRow } = niche
    ? await supabase.from("niche_configurations").select("editing_style_preset").eq("niche_name", niche).single()
    : { data: null };
  const { region, publishAt } = nextPublishSlot(nicheRow?.editing_style_preset?.uploadHourUtc ?? null);
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
    const token = getChannelToken(channelKey);
    if (!token) {
      await logEvent("Agent 5", `No refresh token for channel "${channelKey}"`, { jobId, level: "warn" });
    } else {
      await logEvent("Agent 5", `Uploading to YouTube (channel: ${channelKey})...`, { jobId });

      const videoRes = await withRetry(() => fetch(videoUrl), { label: "fetch render" });
      if (!videoRes.ok) throw new Error(`Could not fetch render: HTTP ${videoRes.status}`);

      const yt = youtubeClient(channelKey);
      const { data } = await withRetry(
        () => yt.videos.insert({
          part: ["snippet", "status"],
          requestBody: {
            snippet: {
              title: title.slice(0, 100),
              description: `${finalDescription}\n\n#Shorts\n\nA MythosVibe production — Tushant Sharma`,
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
      publishedTo.push({ platform: 'youtube', videoId: data.id, status: 'scheduled' });
      await supabase.from("publish_targets").upsert({
        pipeline_log_id: jobId,
        platform: "youtube",
        mode: "direct",
        status: "scheduled",
        package: publishPackage ? {
          video: publishPackage.video,
          subtitles: publishPackage.subtitles,
          metadata: publishPackage.metadata,
          variant: publishPackage.platform_variants?.youtube || {},
          monetization: publishPackage.monetization,
        } : {},
        external_id: data.id,
        scheduled_at: publishAt.toISOString(),
      }, { onConflict: "pipeline_log_id,platform" });
      uploadSuccess = true;
      await logEvent("Agent 5", `✓ YouTube scheduled: ${data.id} → ${region}`, { jobId });
    }
  } catch (err) {
    await logEvent("Agent 5", `YouTube upload failed: ${err.message}`, { jobId, level: "error" });
    // YouTube upload failed - don't mark as scheduled
  }

  // ── Instagram Reels (Graph API — requires INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_BUSINESS_ID) ──
  if (config.instagram.accessToken && config.instagram.businessId) {
    try {
      await logEvent("Agent 5", "Uploading to Instagram Reels...", { jobId });
      const igVariant = publishPackage?.platform_variants?.instagram || {};
      const caption = igVariant.caption || `${title}\n\n${(description || "").slice(0, 300)}`;
      const igResult = await uploadToInstagram({
        videoUrl,
        caption: caption.slice(0, 2200),
        businessId: config.instagram.businessId,
        accessToken: config.instagram.accessToken,
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

  // ── TikTok (Content Posting API — requires TIKTOK_ACCESS_TOKEN from approved app) ──
  if (config.tiktok.accessToken) {
    try {
      await logEvent("Agent 5", "Uploading to TikTok...", { jobId });
      const ttVariant = publishPackage?.platform_variants?.tiktok || {};
      const ttResult = await uploadToTikTok({
        videoUrl,
        title: (ttVariant.caption || title || "").slice(0, 150),
        accessToken: config.tiktok.accessToken,
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
      publish_schedule: publishAt.toISOString(),
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
  if (initData.error?.code !== "ok" && initData.data?.upload_url !== "DIRECT_URL") {
    // When source=URL, TikTok processes the video directly — no separate upload step needed
    // The publish_id is returned for polling
  }
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
