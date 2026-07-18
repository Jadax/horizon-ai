import "dotenv/config";

function parseJsonEnv(name, fallback) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : fallback;
  } catch {
    console.warn(`[config] ${name} is not valid JSON — ignoring`);
    return fallback;
  }
}

const required = [
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "SHOTSTACK_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(
    `[config] Missing env vars: ${missing.join(", ")} — related integrations will report Disconnected.`
  );
}

export const config = {
  openaiKey: process.env.OPENAI_API_KEY,
  elevenLabsKey: process.env.ELEVENLABS_API_KEY,
  shotstack: {
    key: process.env.SHOTSTACK_API_KEY,
    env: process.env.SHOTSTACK_ENV || "stage",
    get baseUrl() {
      return `https://api.shotstack.io/${this.env}`;
    },
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  pexelsKey: process.env.PEXELS_API_KEY,
  pixabayKey: process.env.PIXABAY_API_KEY,
  
  // ─── Apify / VideoIntel API ─────────────────────────────────────
  apifyApiKey: process.env.APIFY_API_KEY,
  apifyActorId: process.env.APIFY_ACTOR_ID || "upworkprashantp/videointel-video-metadata-extractor",
  
  // ─── Quality Gate ────────────────────────────────────────────────
  qualityScoreThreshold: parseFloat(process.env.QUALITY_SCORE_THRESHOLD) || 7.0,
  
  vimeoAccessToken: process.env.VIMEO_ACCESS_TOKEN,
  visualQualityGate: (process.env.VISUAL_QUALITY_GATE || "true").toLowerCase() === "true",
  socialFeedHeaders: parseJsonEnv("SOCIAL_RSS_HEADERS", {}),
  
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI || "http://localhost:8080/oauth2callback",
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    channels: (() => {
      try {
        return process.env.GOOGLE_CHANNELS ? JSON.parse(process.env.GOOGLE_CHANNELS) : {};
      } catch {
        console.warn("[config] GOOGLE_CHANNELS is not valid JSON — ignoring");
        return {};
      }
    })(),
  },
  port: parseInt(process.env.PORT || "8080", 10),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "change-me",
  pipelineCron: process.env.PIPELINE_CRON || "0 3 * * *",
  videosPerRun: parseInt(process.env.VIDEOS_PER_RUN || "6", 10),
  autopilot: (process.env.AUTOPILOT || "true").toLowerCase() === "true",
};

export function getChannelToken(channelKey) {
  if (channelKey && channelKey !== "primary" && config.google.channels[channelKey]) {
    return config.google.channels[channelKey];
  }
  return config.google.refreshToken;
}