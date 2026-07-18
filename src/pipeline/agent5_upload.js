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

export function nextPublishSlot() {
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

export async function uploadScheduled({ videoUrl, title, description, tags, jobId, targetChannel, niche }) {
  const { region, publishAt } = nextPublishSlot();
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

      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) throw new Error(`Could not fetch render: HTTP ${videoRes.status}`);

      const yt = youtubeClient(channelKey);
      const { data } = await yt.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title: title.slice(0, 100),
            description: `${finalDescription}\n\n#Shorts\n\nA MythosVibe production — Tushant Sharma`,
            tags: tags?.slice(0, 15),
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
      });

      videoId = data.id;
      publishedTo.push({ platform: 'youtube', videoId: data.id, status: 'scheduled' });
      uploadSuccess = true;
      await logEvent("Agent 5", `✓ YouTube scheduled: ${data.id} → ${region}`, { jobId });
    }
  } catch (err) {
    await logEvent("Agent 5", `YouTube upload failed: ${err.message}`, { jobId, level: "error" });
    // YouTube upload failed - don't mark as scheduled
  }

  // ── Instagram Reels - STUB (requires full API implementation) ──────
  // if (config.publishTo.includes('instagram') && config.instagram?.accessToken) { ... }

  // ── Facebook Reels - STUB (requires full API implementation) ──────
  // if (config.publishTo.includes('facebook') && config.facebook?.accessToken) { ... }

  // ── TikTok - STUB (requires full API implementation) ──────────────
  // if (config.publishTo.includes('tiktok') && config.tiktok?.accessToken) { ... }

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