/**
 * AGENT 4 — THE SHOTSTACK EDIT GENERATOR
 *
 * Compiles a Shotstack Edit API JSON payload from:
 *   - trimmed licensed clips (Agent 1 + Agent 2's cut list)
 *   - the ElevenLabs voiceover track
 *   - the music_library background track (ducked per style preset)
 *   - word-by-word active caption layers synced to voiceover timestamps
 * Posts to Shotstack and polls until the render completes.
 */
import { config } from "../config.js";
import { logEvent } from "../supabase.js";

const STYLE_FONTS = {
  "heavy-sans": { family: "Montserrat ExtraBold", size: 46 },
  minimal: { family: "Roboto", size: 34 },
  warm: { family: "Poppins", size: 42 },
  "word-clip": { family: "Montserrat ExtraBold", size: 96 },
};

function captionClips(words, preset) {
  // Word-clip mode: one giant word/short-phrase per beat, punchy pacing.
  // Otherwise: group words into 2-3 word chunks — the standard "active
  // caption" look.
  const chunkSize = preset.wordClipMode ? 1 : preset.transitions === "fast-cut" ? 2 : 3;
  const font = preset.wordClipMode
    ? STYLE_FONTS["word-clip"]
    : STYLE_FONTS[preset.caption.style] || STYLE_FONTS.minimal;
  const clips = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize);
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end;
    clips.push({
      asset: {
        type: "text",
        text: chunk.map((w) => w.word).join(" ").toUpperCase(),
        font: {
          family: font.family,
          size: font.size,
          color: preset.caption.color,
        },
        stroke: { color: "#000000", width: preset.caption.style === "minimal" ? 0 : 3 },
        alignment: { horizontal: "center" },
        width: preset.wordClipMode ? 1000 : 900,
        height: preset.wordClipMode ? 320 : 200,
      },
      start: Number(start.toFixed(2)),
      length: Number(Math.max(0.2, end - start).toFixed(2)),
      position: preset.caption.position === "bottom" ? "bottom" : "center",
      offset: preset.caption.position === "bottom" ? { y: 0.12 } : { y: 0 },
      transition: preset.transitions === "fast-cut" ? undefined : { in: "fade", out: "fade" },
    });
  }
  return clips;
}

function videoClips(cuts, preset, totalDuration) {
  let cursor = 0;
  const clips = [];
  for (const cut of cuts) {
    if (cursor >= totalDuration + 1.5) break;
    const length = Math.min(cut.length, totalDuration + 2 - cursor);
    clips.push({
      asset: { type: "video", src: cut.url, trim: Number(cut.start.toFixed(2)), volume: 0 },
      start: Number(cursor.toFixed(2)),
      length: Number(length.toFixed(2)),
      fit: "cover",
      scale: 1,
      effect: "zoomIn",
      transition:
        preset.transitions === "cross-dissolve"
          ? { in: "fade", out: "fade" }
          : undefined,
    });
    cursor += length;
  }
  return clips;
}

export function buildEditPayload({ cuts, voiceoverUrl, words, duration, musicTrack, preset, jobId }) {
  const total = duration + 1.5;
  const tracks = [
    { clips: captionClips(words, preset) }, // top layer: captions
    { clips: videoClips(cuts, preset, duration) }, // video layer
    {
      clips: [
        {
          asset: { type: "audio", src: voiceoverUrl, volume: 1 },
          start: 0,
          length: Number(duration.toFixed(2)),
        },
      ],
    },
  ];

  if (musicTrack) {
    // Shotstack volume is 0-1; convert the preset's dB duck to a linear approx
    const db = preset.music_db ?? -18;
    const volume = Number(Math.pow(10, db / 20).toFixed(3)); // -18dB ≈ 0.126
    // NOTE: Shotstack's "effect" (fadeIn/fadeOut) is only valid on the
    // timeline-level `soundtrack` object, NOT as a property on a regular
    // audio clip inside a track — setting it there gets validated against
    // the video/image zoom-effect enum instead and is rejected (this was
    // the actual cause of the "expected zoomIn|zoomInSlow|..." error).
    // A keyframed volume fade (like the offset animation Shotstack's docs
    // show) may also be possible, but isn't confirmed for the volume
    // property specifically — rather than guess and risk another
    // validation failure, music ends on a static volume with a hard cut.
    // Worth revisiting once actually confirmed against Shotstack's schema.
    tracks.push({
      clips: [
        {
          asset: { type: "audio", src: musicTrack.track_url, volume },
          start: 0,
          length: Number(total.toFixed(2)),
        },
      ],
    });
  }

  return {
    timeline: { background: "#000000", tracks },
    output: {
      format: "mp4",
      resolution: "hd",
      aspectRatio: "9:16",
      fps: 30,
    },
    callback: undefined,
    disk: "local",
  };
}

export async function render(payload, jobId) {
  return renderWithBaseUrl(payload, jobId, config.shotstack.baseUrl, config.shotstack.env);
}

/**
 * Forces a v1 (production, no watermark, paid) render regardless of the
 * configured SHOTSTACK_ENV default. Used by the dashboard's "Render
 * Production" action so day-to-day testing can stay on the free stage
 * environment, and only videos you've actually approved incur real
 * Shotstack cost — instead of every render defaulting to paid.
 */
export async function renderProduction(payload, jobId) {
  const v1BaseUrl = config.shotstack.baseUrl.replace(/\/(stage|v1)$/, "/v1");
  return renderWithBaseUrl(payload, jobId, v1BaseUrl, "v1 (forced)");
}

async function renderWithBaseUrl(payload, jobId, baseUrl, envLabel) {
  await logEvent("Agent 4", `Pushing edit JSON to Shotstack (${envLabel})…`, { jobId });
  const res = await fetch(`${baseUrl}/render`, {
    method: "POST",
    headers: {
      "x-api-key": config.shotstack.key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Shotstack submit → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const { response } = await res.json();
  const renderId = response.id;
  await logEvent("Agent 4", `Render queued: ${renderId} — polling…`, { jobId });

  // Poll every 10s, up to 15 minutes
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const poll = await fetch(`${baseUrl}/render/${renderId}`, {
      headers: { "x-api-key": config.shotstack.key },
    });
    const { response: status } = await poll.json();
    if (status.status === "done") {
      await logEvent("Agent 4", `Render complete → ${status.url}`, { jobId });
      return { renderId, url: status.url };
    }
    if (status.status === "failed") {
      throw new Error(`Shotstack render failed: ${status.error || "unknown"}`);
    }
    if (i % 3 === 0) {
      await logEvent("Agent 4", `Render status: ${status.status}…`, { jobId });
    }
  }
  throw new Error("Shotstack render timed out after 15 minutes");
}
