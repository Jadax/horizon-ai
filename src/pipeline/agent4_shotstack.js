import { config } from "../config.js";
import { logEvent } from "../supabase.js";
import { renderVideo, checkRenderEngine } from "../lib/freeVideoRender.js";
import { pickSfx } from "./agent3_audio.js";

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

export async function buildEditPayload({ cuts, voiceoverUrl, words, duration, musicTrack, preset, jobId, isSourceVideo = false }) {
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
        overlay: cut.overlay || null,
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

  // FIRST-FRAME HOOK: the algorithm samples a Short within its first 0.8s,
  // so even non-illustrated niches get a punchy on-screen hook burned over
  // frame 1 (research: 3s hold 54% → 71% with first-frame text). Pulls the
  // script's opening 4-7 words as ALL-CAPS bold text in the niche's overlay
  // style for the first ~3 seconds — skipped for word-clip mode, where the
  // captions themselves already ARE the on-screen words.
  const overlays = videoClips
    .filter((clip) => clip.overlay && Number.isFinite(clip.timelineStart))
    .map((clip) => ({
      text: clip.overlay,
      start: clip.timelineStart,
      end: Math.min(clip.timelineStart + 3.2, clip.timelineEnd ?? clip.timelineStart + 3.2),
    }));
  if (!preset.wordClipMode && !overlays.some((o) => o.start < 0.5)) {
    const hookText = words
      .slice(0, 7)
      .map((w) => w.word)
      .filter(Boolean)
      .join(" ")
      .toUpperCase()
      .slice(0, 40);
    if (hookText) {
      overlays.unshift({ text: hookText, start: 0, end: Math.min(3.0, videoClips[0]?.timelineEnd ?? 3.0) });
    }
  }

  // SFX layer (playbook spec: sparse one-shot sounds at -6 to -10 dB under
  // the VO, placed at key visual moments). Hook at ~0.8s, payoff on the tail.
  // Only fires if sfx_library has matching rows — an empty library is a no-op.
  const sfx = [];
  try {
    const [hookSfx, payoffSfx] = await Promise.all([
      pickSfx(["hook", "pop", "ding", "impact"], jobId),
      pickSfx(["payoff", "chime", "impact", "whoosh"], jobId),
    ]);
    if (hookSfx?.url) sfx.push({ url: hookSfx.url, start: 0.8 });
    if (payoffSfx?.url && payoffSfx.url !== hookSfx?.url) {
      sfx.push({ url: payoffSfx.url, start: Math.max(0, total - 1.8) });
    }
  } catch {
    // SFX is enhancement, never load-bearing — a DB hiccup must not fail the render
  }

  // Caption size follows the Blitzcut spec per format: word-clip cards are the
  // on-screen words (hype 75-95px), fast-cut is punchy (84px), narrated
  // explainers sit in the standard band (72px). A dashboard-set fontsize wins.
  const defaultFontsize = preset.wordClipMode ? 96 : preset.transitions === "fast-cut" ? 84 : 72;

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
    captionStyle: { ...(preset.caption || {}), fontsize: Number(preset.caption?.fontsize) || defaultFontsize },
    color_preset: preset.color_preset || "classic_white",
    // Bold comic-style text burned over each clip's first seconds (the
    // attachment-style "ONLY 10 YEARS LEFT!" look) — rendered by libass,
    // never drawn by the image model, so it can't be misspelled. First
    // clip's overlay is the 3-second visual hook.
    overlays,
    sfx,
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
