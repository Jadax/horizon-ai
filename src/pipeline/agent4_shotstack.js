import { config } from "../config.js";
import { logEvent } from "../supabase.js";
import { renderVideo, checkRenderEngine } from "../lib/freeVideoRender.js";

const STYLE_FONTS = {
  "heavy-sans": { family: "Montserrat ExtraBold", size: 46 },
  minimal: { family: "Roboto", size: 34 },
  warm: { family: "Poppins", size: 42 },
  "word-clip": { family: "Montserrat ExtraBold", size: 96 },
};

const DEFAULT_CLIP_PRESET = {
  caption: { style: "heavy-sans", color: "#FFFFFF", position: "bottom" },
  transitions: "cross-dissolve",
  wordClipMode: false,
};

export function captionClips(words, preset) {
  const chunkSize = preset.wordClipMode ? 1 : preset.transitions === "fast-cut" ? 2 : 3;
  const font = preset.wordClipMode
    ? STYLE_FONTS["word-clip"]
    : STYLE_FONTS[preset.caption?.style] || STYLE_FONTS.minimal;
  const clips = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize);
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end;
    clips.push({
      text: chunk.map((w) => w.word).join(" ").toUpperCase(),
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
    });
  }
  return clips;
}

export function buildEditPayload({ cuts, voiceoverUrl, words, duration, musicTrack, preset, jobId, isSourceVideo = false }) {
  const total = duration;

  let videoClips = [];
  if (isSourceVideo && cuts.length === 1) {
    const clip = cuts[0];
    videoClips = [{
      url: clip.url,
      type: clip.type === "image" ? "image" : "video",
      start: clip.start,
      duration: Math.min(clip.length, total),
    }];
  } else {
    for (const cut of cuts.filter((item) => Number.isFinite(item.timelineStart) && Number.isFinite(item.timelineEnd) && item.timelineEnd > item.timelineStart)) {
      if ((cut.timelineStart ?? 0) >= total) break;
      const length = Math.min(cut.timelineEnd - cut.timelineStart, total - cut.timelineStart);
      videoClips.push({
        url: cut.url,
        type: cut.type === "image" ? "image" : "video",
        start: cut.start,
        duration: length,
        timelineStart: cut.timelineStart,
        timelineEnd: cut.timelineEnd,
      });
    }
  }
  if (!videoClips.length) throw new Error("Render has no timeline-grounded visual clips");
  if (!words?.length || Number(words.at(-1).end) <= 0) throw new Error("Render requires authoritative TTS word timestamps");
  if (Number(words.at(-1).end) > duration + 0.1) throw new Error("Word timeline exceeds narration duration");
  for (let i = 1; i < videoClips.length; i++) {
    if (Math.abs(videoClips[i].timelineStart - videoClips[i - 1].timelineEnd) > 0.05) {
      throw new Error("Visual timeline has a gap or overlap greater than 50ms");
    }
  }

  return {
    // backgroundVideo kept for any caller still expecting a single URL
    // (e.g. render-video-api's minimal payload shape); backgroundClips
    // carries the FULL cut sequence — buildEditPayload previously computed
    // this and then discarded everything but the first clip here, so every
    // rendered video only ever showed one background clip for its entire
    // duration regardless of how many cuts Agent 2 calculated.
    backgroundVideo: videoClips[0]?.url || null,
    backgroundClips: videoClips,
    audioUrl: voiceoverUrl,
    musicUrl: musicTrack?.track_url || null,
    duration: total,
    captions: captionClips(words, preset),
    syncPrecisionMs: config.subtitleSyncPrecisionMs,
    output: {
      format: "mp4",
      resolution: "1080x1920",
      fps: 30,
    },
  };
}

export async function render(payload, jobId) {
  await logEvent("Agent 4", `Rendering video using free engine (${config.renderEngine || 'render-api'})...`, { jobId });
  
  const isAvailable = await checkRenderEngine();
  if (!isAvailable) {
    await logEvent("Agent 4", `⚠️ Render engine not available, using FFmpeg fallback`, { jobId, level: "warn" });
  }
  
  const result = await renderVideo(payload, jobId);
  
  await logEvent("Agent 4", `Render complete → ${result.url} (FREE)`, { jobId });
  return result;
}

export async function renderProduction(payload, jobId) {
  return render(payload, jobId);
}
