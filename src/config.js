import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function parseJsonEnv(name, fallback) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : fallback;
  } catch {
    console.warn(`[config] ${name} is not valid JSON — ignoring`);
    return fallback;
  }
}

function parseArrayEnv(name, fallback = []) {
  try {
    return process.env[name] ? process.env[name].split(',').map(s => s.trim()) : fallback;
  } catch {
    return fallback;
  }
}

export const config = {
  // ─── OpenAI (Keep) ──────────────────────────────────────────────────
  openaiKey: process.env.OPENAI_API_KEY,
  // Free-tier Gemini key — when set, all text-only LLM calls route through
  // Gemini first (see lib/llm.js) with OpenAI as the paid fallback.
  geminiKey: process.env.GEMINI_API_KEY,
  
  // ─── Free TTS ──────────────────────────────────────────────────────
  // Defaults to 'gtts', not 'chatterbox' — chatterbox is a Python library
  // with no HTTP server, so it can't work without you deploying your own
  // wrapper for it first (see .env.example). gtts runs in-process via a
  // python3 subprocess, no separate service needed.
  // 'openai' (gpt-4o-mini-tts) is the default: dramatically more natural
  // than gTTS's robotic translate voice, uses the already-required OpenAI
  // key (~$0.01 per video of narration), and freeTTS.js still falls back to
  // gtts automatically if the call fails.
  ttsEngine: process.env.TTS_ENGINE || 'gemini',
  ttsApiUrl: process.env.TTS_API_URL || 'http://localhost:5000/tts',
  ttsFallback: process.env.TTS_FALLBACK || 'gtts',
  
  // ─── Free Video Render ──────────────────────────────────────────────
  // Defaults to 'ffmpeg' (any value other than 'render-api'/'shottower'
  // falls through to the local FFmpeg renderer, which needs no separate
  // service — ffmpeg-static ships as an npm dependency and runs in-process).
  renderApiUrl: process.env.RENDER_API_URL || 'http://localhost:3000',
  renderEngine: process.env.RENDER_ENGINE || 'ffmpeg',
  // render-video-api requires an API key (x-api-key header) obtained by
  // registering + generating one through its own dashboard — this can't be
  // auto-provisioned, see .env.example.
  renderApiKey: process.env.RENDER_API_KEY,

  // ─── Free Stock Footage ─────────────────────────────────────────────
  pexelsKey: process.env.PEXELS_API_KEY?.trim() || null,
  pixabayKey: process.env.PIXABAY_API_KEY,
  visualQualityGate: (process.env.VISUAL_QUALITY_GATE || "true").toLowerCase() === "true",
  bypassQaForSource: (process.env.BYPASS_QA_FOR_SOURCE || "true").toLowerCase() === "true",
  // Generates a still image (OpenAI gpt-image-1) for a script beat when no
  // real stock footage matches it, instead of forcing a mismatched clip or
  // reaching for scraped third-party video. Real per-image cost — capped at
  // 4/video in agent1_harvester.js (AI_CUTAWAY_MAX_PER_VIDEO).
  enableAiCutaway: (process.env.ENABLE_AI_CUTAWAY || "true").toLowerCase() === "true",
  // "pollinations" (default): free FLUX-based generation, no key, $0 — used
  // for illustrated-mode frames, with gpt-image-1 as automatic fallback.
  // Set IMAGE_ENGINE=openai to force gpt-image-1 for everything.
  imageEngine: (process.env.IMAGE_ENGINE || "pollinations").toLowerCase(),
  // Minimum virality score (1-10) for a scraped video candidate to be used
  // as a topic — restored, was dropped in the free-stack rewrite (agent1_harvester.js
  // still reads this with a || 7.0 fallback, so it degraded silently, not a crash).
  qualityScoreThreshold: parseFloat(process.env.QUALITY_SCORE_THRESHOLD) || 7.0,

  // Long-form clipper (Agent 6): personal access token for YOUR OWN Vimeo
  // account — restored, was dropped in the free-stack rewrite, silently
  // disabling the "Or your own Vimeo video" dashboard form (routes/clips.js
  // degraded to always returning "not configured" rather than crashing).
  vimeoAccessToken: process.env.VIMEO_ACCESS_TOKEN,
  
  // ─── Supabase (Free tier) ───────────────────────────────────────────
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  
  // ─── YouTube Upload (Free OAuth) ────────────────────────────────────
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || "http://localhost:8080/oauth2callback",
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    channels: (() => {
      try {
        return process.env.GOOGLE_CHANNELS ? JSON.parse(process.env.GOOGLE_CHANNELS) : {};
      } catch {
        return {};
      }
    })(),
  },

  // Instagram cross-post channels: {"leothecat":{"handle":"@LeoTheCat","user_id":"..."}}
  // Currently package-mode only (no direct IG API); used for labeled publish targets.
  instagramChannels: (() => {
    try {
      return process.env.INSTAGRAM_CHANNELS ? JSON.parse(process.env.INSTAGRAM_CHANNELS) : {};
    } catch {
      return {};
    }
  })(),

  // TikTok cross-post channels: {"leothecat":{"handle":"@LeoTheCat","open_id":"..."}}  // Package-mode (no direct TikTok API yet); used for labeled publish targets.
  tiktokChannels: (() => {
    try {
      return process.env.TIKTOK_CHANNELS ? JSON.parse(process.env.TIKTOK_CHANNELS) : {};
    } catch {
      return {};
    }
  })(),
  
  // ─── Server ──────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT || "8080", 10),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "change-me",
  pipelineCron: process.env.PIPELINE_CRON || "0 3 * * *",
  videosPerRun: parseInt(process.env.VIDEOS_PER_RUN || "6", 10),
  autopilot: (process.env.AUTOPILOT || "true").toLowerCase() === "true",
  // Default 78, measured against the critic's actual score distribution
  // (gpt-4o with the calibrated rubric in contentQuality.js): filler-content
  // scripts grade ~35-45, genuinely strong ones ~78-84, so 78 separates the
  // clusters. Fabrication/incoherence still hard-fail at ANY score via
  // blocking_issues. Not clamped to a floor — the previous Math.max(85, ...)
  // silently ignored lower env values and sat above where the critic ever
  // scored real work, which walled off every single run.
  contentQualityThreshold: parseInt(process.env.CONTENT_QUALITY_THRESHOLD || "78", 10),
  subtitleSyncPrecisionMs: Math.min(50, parseInt(process.env.SUBTITLE_SYNC_PRECISION_MS || "50", 10)),
  publishPlatforms: parseArrayEnv("PUBLISH_PLATFORMS", ["youtube"]),
  
  // ─── Affiliate (Optional) ──────────────────────────────────────────
  affiliate: {
    trackingId: process.env.AFFILIATE_TRACKING_ID || null,
  },

  // ─── yt-dlp (free, open-source video downloader) ─────────────────────
  // Path to the yt-dlp binary. Defaults to "yt-dlp" (on PATH).
  ytDlpPath: process.env.YT_DLP_PATH || "yt-dlp",

  // ─── Leo (local cat-video niche) ────────────────────────────────────
  leoInboxDir: path.resolve(PROJECT_ROOT, process.env.LEO_INBOX_DIR || "leo_inbox"),
  // ElevenLabs cloned voice for Leo narrations (the personal-voice slot).
  // Both unset → OpenAI "coral". Requires the voice owner's consent.
  leoVoiceId: process.env.LEO_VOICE_ID || null,
  elevenlabsKey: process.env.ELEVENLABS_API_KEY || null,
  // YouTube channel URL for Leo (for reference analysis of top pet accounts).
  // Set to a top pet channel to analyze their strategy for your own content.
  leoReferenceChannel: process.env.LEO_REFERENCE_CHANNEL || null,
  // Leo's own YouTube channel handle (e.g. @LeoTheCat-x6q) for publish targets.
  leoYoutubeChannel: process.env.LEO_YOUTUBE_CHANNEL || "@LeoTheCat-x6q",
  // Leo's Instagram handle for publish package labels.
  leoInstagramHandle: process.env.LEO_INSTAGRAM_HANDLE || "",

  // ─── Telegram approval notifications (optional, free) ──────────────
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
    // Public base URL for approve/dashboard links in messages (e.g. the
    // Railway app URL). Falls back to localhost, which only works locally.
    publicUrl: process.env.PUBLIC_URL || null,
  },
};

export function getChannelToken(channelKey) {
  if (channelKey && channelKey !== "primary" && config.google.channels[channelKey]) {
    return config.google.channels[channelKey];
  }
  return config.google.refreshToken;
}
