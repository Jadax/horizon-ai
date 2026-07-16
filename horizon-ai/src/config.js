import "dotenv/config";

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
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI || "http://localhost:8080/oauth2callback",
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  },
  port: parseInt(process.env.PORT || "8080", 10),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "change-me",
  pipelineCron: process.env.PIPELINE_CRON || "0 3 * * *",
  videosPerRun: parseInt(process.env.VIDEOS_PER_RUN || "4", 10),
  autopilot: (process.env.AUTOPILOT || "true").toLowerCase() === "true",
};
