/**
 * ROUTES: SETTINGS — read/write API credentials from the dashboard.
 * Credentials are stored in settings.json (gitignored) and hot-reloaded
 * into the running config on every write.
 */
import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

export const settingsRouter = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.join(__dirname, "../../settings.json");

// Keys the dashboard can read (masked) and write
const CREDENTIALS = [
  { key: "geminiKey", label: "Gemini API Key", env: "GEMINI_API_KEY" },
  { key: "instagramAccessToken", label: "Instagram Access Token", env: "INSTAGRAM_ACCESS_TOKEN" },
  { key: "instagramBusinessId", label: "Instagram Business ID", env: "INSTAGRAM_BUSINESS_ID" },
  { key: "tiktokAccessToken", label: "TikTok Access Token", env: "TIKTOK_ACCESS_TOKEN" },
  { key: "pexelsKey", label: "Pexels API Key", env: "PEXELS_API_KEY" },
  { key: "pixabayKey", label: "Pixabay API Key", env: "PIXABAY_API_KEY" },
  { key: "twitchClientId", label: "Twitch Client ID", env: "TWITCH_CLIENT_ID" },
  { key: "twitchClientSecret", label: "Twitch Client Secret", env: "TWITCH_CLIENT_SECRET" },
  { key: "telegramBotToken", label: "Telegram Bot Token", env: "TELEGRAM_BOT_TOKEN" },
  { key: "telegramChatId", label: "Telegram Chat ID", env: "TELEGRAM_CHAT_ID" },
  { key: "jamendoClientId", label: "Jamendo Client ID", env: "JAMENDO_CLIENT_ID" },
];

async function loadSettings() {
  try { return JSON.parse(await readFile(SETTINGS_PATH, "utf8")); }
  catch { return {}; }
}

function getEffectiveValue(key, env) {
  const stored = _cachedSettings?.[key] || "";
  return stored || process.env[env] || "";
}

let _cachedSettings = null;

// GET /api/settings — masked values for display
settingsRouter.get("/settings", async (_req, res) => {
  _cachedSettings = await loadSettings();
  const result = {};
  for (const { key, label, env } of CREDENTIALS) {
    const val = getEffectiveValue(key, env);
    result[key] = { label, value: val ? `${val.slice(0, 4)}${"*".repeat(Math.max(0, val.length - 4))}` : "", set: !!val };
  }
  res.json(result);
});

// POST /api/settings — save credentials
settingsRouter.post("/settings", async (req, res) => {
  try {
    const stored = await loadSettings();
    const updated = [];
    for (const { key } of CREDENTIALS) {
      if (req.body[key] !== undefined) {
        const val = req.body[key]?.trim() || "";
        stored[key] = val;
        // Hot-reload into running config
        if (key in config) config[key] = val || process.env[key] || null;
        updated.push(key);
      }
    }
    await writeFile(SETTINGS_PATH, JSON.stringify(stored, null, 2));
    _cachedSettings = stored;
    res.json({ ok: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/check — quick status of all platforms
settingsRouter.get("/settings/check", async (_req, res) => {
  _cachedSettings = await loadSettings();
  res.json({
    gemini: !!getEffectiveValue("geminiKey", "GEMINI_API_KEY"),
    instagram: !!(getEffectiveValue("instagramAccessToken", "INSTAGRAM_ACCESS_TOKEN") && getEffectiveValue("instagramBusinessId", "INSTAGRAM_BUSINESS_ID")),
    tiktok: !!getEffectiveValue("tiktokAccessToken", "TIKTOK_ACCESS_TOKEN"),
    pexels: !!getEffectiveValue("pexelsKey", "PEXELS_API_KEY"),
    pixabay: !!getEffectiveValue("pixabayKey", "PIXABAY_API_KEY"),
    telegram: !!(getEffectiveValue("telegramBotToken", "TELEGRAM_BOT_TOKEN") && getEffectiveValue("telegramChatId", "TELEGRAM_CHAT_ID")),
    twitch: !!getEffectiveValue("twitchClientId", "TWITCH_CLIENT_ID"),
  });
});
