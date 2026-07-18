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
    : STYLE_FONTS[preset.caption.style] || STYLE_FONTS.minimal;
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
  const total = duration + 1.5;
  
  let videoClips = [];
  if (isSourceVideo && cuts.length === 1) {
    const clip = cuts[0];
    videoClips = [{
      url: clip.url,
      start: clip.start,
      duration: Math.min(clip.length, total),
    }];
  } else {
    let cursor = 0;
    for (const cut of cuts) {
      if (cursor >= total) break;
      const length = Math.min(cut.length, total - cursor);
      videoClips.push({
        url: cut.url,
        start: cut.start,
        duration: length,
      });
      cursor += length;
    }
  }

  return {
    backgroundVideo: videoClips[0]?.url || null,
    audioUrl: voiceoverUrl,
    musicUrl: musicTrack?.track_url || null,
    duration: total,
    captions: captionClips(words, preset),
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
  return { renderId: result.renderId, url: result.url };
}

export async function renderProduction(payload, jobId) {
  return render(payload, jobId);
}