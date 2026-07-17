import "dotenv/config";

function parseJsonEnv(name, fallback) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : fallback;
  } catch {
    console.warn(`[config] ${name} is not valid JSON â€” ignoring`);
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
    env: process.env.SHOTSTACK_ENV || "stage", // "stage" | "v1"
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
  // A render is blocked when footage cannot be visually verified against its
  // exact narration beat. Disable only for local diagnostics.
  visualQualityGate: (process.env.VISUAL_QUALITY_GATE || "true").toLowerCase() === "true",
  // Map a social feed's `auth_key` to request headers. This permits an
  // operator-authorised private RSS feed while keeping credentials out of
  // Supabase. Example: {"creator_feed":{"Authorization":"Bearer ..."}}.
  socialFeedHeaders: parseJsonEnv("SOCIAL_RSS_HEADERS", {}),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI || "http://localhost:8080/oauth2callback",
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN, // "primary" channel
    // MULTI-CHANNEL SUPPORT: if you run separate channels for different
    // content types, set GOOGLE_CHANNELS as a JSON object mapping a short
    // channel key to its own refresh token, e.g.:
    //   GOOGLE_CHANNELS={"mythosvibe":"1//0abc...","gamingchannel":"1//0xyz..."}
    // Each channel needs its own refresh token (same OAuth client/secret is
    // fine — just re-run `npm run auth:youtube` signed into that channel's
    // Google account and copy the resulting token in here). A niche's
    // `target_channel` column in Supabase picks which one it uploads to;
    // "primary" (or unset) falls back to GOOGLE_REFRESH_TOKEN above.
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

/**
 * Resolves which refresh token to use for a given channel key (a niche's
 * `target_channel` value). "primary", empty, or unrecognized keys all fall
 * back to the main GOOGLE_REFRESH_TOKEN — so single-channel setups (the
 * common case) need zero extra configuration.
 */
export function getChannelToken(channelKey) {
  if (channelKey && channelKey !== "primary" && config.google.channels[channelKey]) {
    return config.google.channels[channelKey];
  }
  return config.google.refreshToken;
}
