import "dotenv/config";

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
  
  // ─── Free TTS ──────────────────────────────────────────────────────
  // Defaults to 'gtts', not 'chatterbox' — chatterbox is a Python library
  // with no HTTP server, so it can't work without you deploying your own
  // wrapper for it first (see .env.example). gtts runs in-process via a
  // python3 subprocess, no separate service needed.
  ttsEngine: process.env.TTS_ENGINE || 'gtts',
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
  pexelsKey: process.env.PEXELS_API_KEY,
  pixabayKey: process.env.PIXABAY_API_KEY,
  visualQualityGate: (process.env.VISUAL_QUALITY_GATE || "true").toLowerCase() === "true",
  bypassQaForSource: (process.env.BYPASS_QA_FOR_SOURCE || "true").toLowerCase() === "true",
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
  
  // ─── Server ──────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT || "8080", 10),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "change-me",
  pipelineCron: process.env.PIPELINE_CRON || "0 3 * * *",
  videosPerRun: parseInt(process.env.VIDEOS_PER_RUN || "6", 10),
  autopilot: (process.env.AUTOPILOT || "true").toLowerCase() === "true",
  qualityGateMode: process.env.QUALITY_GATE_MODE || "warn_only",
  
  // ─── Affiliate (Optional) ──────────────────────────────────────────
  affiliate: {
    trackingId: process.env.AFFILIATE_TRACKING_ID || null,
  },
};

export function getChannelToken(channelKey) {
  if (channelKey && channelKey !== "primary" && config.google.channels[channelKey]) {
    return config.google.channels[channelKey];
  }
  return config.google.refreshToken;
}