/**
 * ROUTES: SETTINGS — read/write API credentials from the dashboard.
 * Credentials are stored in settings.json (gitignored) and hot-reloaded
 * into the running config on every write.
 */
import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

// Flat dashboard key → where it actually lives on the config object (nested
// paths) and which env var backs it. Downstream code reads config.instagram.
//accessToken / config.tiktok.accessToken / config.telegram.* / config.twitch*,
// while musicSync + sources/twitch.js read process.env directly — so a save
// must set BOTH so the running process picks the value up without a restart.
const CONFIG_PATHS = {
  geminiKey: ["geminiKey"],
  instagramAccessToken: ["instagram", "accessToken"],
  instagramBusinessId: ["instagram", "businessId"],
  tiktokAccessToken: ["tiktok", "accessToken"],
  pexelsKey: ["pexelsKey"],
  pixabayKey: ["pixabayKey"],
  twitchClientId: ["twitchClientId"],
  twitchClientSecret: ["twitchClientSecret"],
  telegramBotToken: ["telegram", "botToken"],
  telegramChatId: ["telegram", "chatId"],
  jamendoClientId: ["jamendoClientId"],
};

function setNested(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] ??= {};
  cur[path[path.length - 1]] = value;
}

export function applySettingsToConfig(stored) {
  if (stored === undefined) {
    try { stored = JSON.parse(readFileSync(SETTINGS_PATH, "utf8").replace(/^\uFEFF/, "")); }
    catch { stored = {}; }
  }
  for (const { key, env } of CREDENTIALS) {
    const value = (stored[key] ?? "").trim();
    const path = CONFIG_PATHS[key];
    if (value) {
      if (path) setNested(config, path, value);
      if (env) process.env[env] = value;
    } else if (stored[key] !== undefined) {
      // Explicitly cleared in the dashboard — clear from config + env too
      if (path) setNested(config, path, null);
      if (env) delete process.env[env];
    }
  }
}

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
        stored[key] = req.body[key]?.trim() || "";
        updated.push(key);
      }
    }
    await writeFile(SETTINGS_PATH, JSON.stringify(stored, null, 2));
    _cachedSettings = stored;
    // Hot-reload into the running config (nested paths + process.env)
    applySettingsToConfig(stored);
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
