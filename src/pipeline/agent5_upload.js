/**
 * AGENT 5 — MULTI-REGION OPTIMIZATION & AUTOMATED UPLOAD
 *
 * - Rotates target regions (India, SE Asia, South Africa, US) and computes
 *   the next local peak-engagement window converted to UTC.
 * - Downloads the Shotstack render and uploads to YouTube as PRIVATE with
 *   publishAt set — YouTube flips it public at the scheduled instant, which
 *   is the quota-friendly "private draft, scheduled" pattern.
 * - MULTI-CHANNEL: each niche can target a different YouTube channel via
 *   its `target_channel` value (see config.js's getChannelToken and the
 *   dashboard's Channel Routing panel). Single-channel setups need zero
 *   extra config — everything defaults to the "primary" channel.
 */
import { google } from "googleapis";
import { Readable } from "node:stream";
import { config, getChannelToken } from "../config.js";
import { logEvent } from "../supabase.js";

// Local peak windows (hour of day, local time) per region — Shorts evening peaks
const REGIONS = [
  { name: "India", tzOffset: 5.5, peakHour: 19 },
  { name: "Southeast Asia", tzOffset: 7, peakHour: 20 },
  { name: "South Africa", tzOffset: 2, peakHour: 18 },
  { name: "United States", tzOffset: -5, peakHour: 17 }, // ET as anchor
];

let regionCursor = 0;

export function nextPublishSlot() {
  const region = REGIONS[regionCursor % REGIONS.length];
  regionCursor++;

  const now = new Date();
  // Peak hour local → UTC hour
  let utcHour = region.peakHour - region.tzOffset;
  const slot = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  slot.setUTCMinutes(Math.round((utcHour % 1) * 60));
  slot.setUTCHours(Math.floor((utcHour + 24) % 24));
  if (slot <= now) slot.setUTCDate(slot.getUTCDate() + 1); // next occurrence

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

export async function uploadScheduled({ videoUrl, title, description, tags, jobId, targetChannel }) {
  const { region, publishAt } = nextPublishSlot();
  const channelKey = targetChannel || "primary";
  await logEvent(
    "Agent 5",
    `Target: ${region} peak window → publishes ${publishAt.toISOString()} (channel: ${channelKey})`,
    { jobId }
  );

  const token = getChannelToken(channelKey);
  if (!token) {
    await logEvent(
      "Agent 5",
      `No refresh token for channel "${channelKey}" — run \`npm run auth:youtube\` (or add it to GOOGLE_CHANNELS). Holding video.`,
      { jobId, level: "warn" }
    );
    return { region, publishAt, videoId: null, held: true };
  }

  // Stream the rendered MP4 straight from Shotstack CDN into the upload
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Could not fetch render for upload: HTTP ${videoRes.status}`);

  const yt = youtubeClient(channelKey);
  await logEvent("Agent 5", `Uploading to YouTube as private + scheduled…`, { jobId });

  const { data } = await yt.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description: `${description}\n\n#Shorts\n\nA MythosVibe production — Tushant Sharma`,
        tags: tags?.slice(0, 15),
        categoryId: "24", // Entertainment
      },
      status: {
        privacyStatus: "private",
        publishAt: publishAt.toISOString(),
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: true, // AI voiceover disclosure — required by YouTube policy
      },
    },
    media: { body: Readable.fromWeb(videoRes.body) },
  });

  await logEvent("Agent 5", `Scheduled ✓ video ${data.id} → ${region}, ${publishAt.toISOString()}`, { jobId });
  return { region, publishAt, videoId: data.id, held: false };
}
