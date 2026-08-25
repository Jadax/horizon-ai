/**
 * ROUTES: CHANNEL LINKING — connect YouTube/Instagram/TikTok accounts from
 * the dashboard instead of the CLI + manual env-var + redeploy flow. See
 * lib/linkedChannels.js for where the resulting credentials are stored and
 * resolved at upload time.
 *
 * YouTube uses a real OAuth flow (googleapis, same client as
 * lib/youtubeAuth.js's CLI script). Instagram/TikTok use a paste-token flow:
 * both need a Meta/TikTok-approved app for a real "Login with X" button, so
 * for now the operator pastes the long-lived token they already generated
 * via their own Meta/TikTok developer console — see CLAUDE.md's known
 * operational blockers for why that's the honest option today.
 */
import express from "express";
import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { config } from "../config.js";
import { logEvent } from "../supabase.js";
import { upsertLinkedChannel, deleteLinkedChannel, mergedChannelList } from "../lib/linkedChannels.js";

export const channelAuthRouter = express.Router();

function callbackUrl(req) {
  return `${req.protocol}://${req.get("host")}/api/auth/youtube/callback`;
}

// Escape every interpolated value in the callback page — this route is
// auth-exempt (Google's redirect carries no header), so reflected input
// (?error=, state payload, provider error messages) was raw HTML injection.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// OAuth linking-state nonces: the old state was plain base64(JSON), fully
// client-craftable — an attacker could complete the consent flow with THEIR
// Google account and hand back a state that stored their refresh token as a
// linked channel (upload hijack). Server-issued single-use nonces close it.
const PENDING_STATES = new Map(); // nonce → { channelKey, label, expiresAt }
const STATE_TTL_MS = 10 * 60 * 1000;

function issueState(channelKey, label) {
  // Opportunistic cleanup of expired entries.
  for (const [k, v] of PENDING_STATES) {
    if (v.expiresAt < Date.now()) PENDING_STATES.delete(k);
  }
  const nonce = randomBytes(16).toString("hex");
  PENDING_STATES.set(nonce, { channelKey, label, expiresAt: Date.now() + STATE_TTL_MS });
  return nonce;
}

function consumeState(nonce) {
  const entry = PENDING_STATES.get(String(nonce || ""));
  if (!entry) return null;
  PENDING_STATES.delete(String(nonce));
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// GET /api/auth/youtube/start — kicks off the Google consent screen. Called
// via a plain link/window.open from the dashboard (carries ?key= for auth
// since it's a full navigation, not a fetch with an Authorization header).
channelAuthRouter.get("/auth/youtube/start", (req, res) => {
  const channelKey = String(req.query.channel_key || "").trim();
  const label = String(req.query.label || "").trim();
  if (!channelKey || !label) return res.status(400).send("channel_key and label are required");

  const oauth2 = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, callbackUrl(req));
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    state: issueState(channelKey, label),
  });
  res.redirect(url);
});

// GET /api/auth/youtube/callback — Google redirects here with ?code=&state=.
// Exempted from the dashboard-password auth middleware (see index.js); the
// proof of legitimacy is the code PLUS a server-issued, unspent state nonce.
channelAuthRouter.get("/auth/youtube/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const page = (title, body) => res.send(`<!doctype html><html><head><title>${esc(title)}</title>
    <style>body{font-family:system-ui,sans-serif;background:#0a0a12;color:#f1f5f9;display:flex;align-items:center;
    justify-content:center;height:100vh;margin:0}.box{text-align:center;max-width:420px;padding:32px}
    h1{font-size:18px}p{color:#9ba8c0;font-size:14px;line-height:1.6}</style></head>
    <body><div class="box"><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`);

  if (oauthError) return page("Connection cancelled", `Google reported: ${oauthError}. You can close this tab.`);
  if (!code || !state) return page("Missing authorization", "No code/state received from Google. Close this tab and try again.");

  // Single-use consume happens BEFORE any token exchange so a replayed or
  // crafted state can never link anything.
  const pending = consumeState(state);
  if (!pending) {
    return page("Expired linking request", "This linking attempt is invalid, already used, or older than 10 minutes. Close this tab and start again from the dashboard.");
  }
  const { channelKey, label } = pending;

  try {
    const oauth2 = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, callbackUrl(req));
    const { tokens } = await oauth2.getToken(String(code));
    if (!tokens.refresh_token) {
      return page(
        "No refresh token returned",
        "Google didn't return a refresh token — this usually means this account already granted access before. Go to your Google Account's third-party access settings, remove Horizon AI's access, then try connecting again."
      );
    }
    oauth2.setCredentials(tokens);
    const yt = google.youtube({ version: "v3", auth: oauth2 });
    let handle = null;
    try {
      const { data } = await yt.channels.list({ part: ["snippet"], mine: true });
      handle = data.items?.[0]?.snippet?.title || null;
    } catch { /* cosmetic only */ }

    await upsertLinkedChannel({
      platform: "youtube",
      channel_key: channelKey,
      label,
      handle,
      credentials: { refresh_token: tokens.refresh_token },
    });
    await logEvent("Channel Manager", `✓ YouTube channel connected: "${label}" (${handle || channelKey})`);
    return page("YouTube connected ✓", `"${label}" (${handle || channelKey}) is now linked. You can close this tab and go back to the dashboard.`);
  } catch (err) {
    return page("Connection failed", err.message || "Unknown error. Close this tab and try again.");
  }
});

// GET /api/channels/:platform — list every linked + legacy-env channel for
// a platform, for the dashboard's channel pickers.
channelAuthRouter.get("/channels/:platform", async (req, res) => {
  const platform = req.params.platform;
  if (!["youtube", "instagram", "tiktok"].includes(platform)) return res.status(400).json({ error: "Unknown platform" });
  res.json(await mergedChannelList(platform));
});

// POST /api/channels/:platform — paste-token linking for Instagram/TikTok
// (YouTube uses the OAuth flow above instead).
channelAuthRouter.post("/channels/:platform", async (req, res) => {
  const platform = req.params.platform;
  if (!["instagram", "tiktok"].includes(platform)) {
    return res.status(400).json({ error: "Use /api/auth/youtube/start to link YouTube" });
  }
  const { channel_key, label, handle, access_token, business_id } = req.body || {};
  if (!channel_key || !label || !access_token) {
    return res.status(400).json({ error: "channel_key, label, and access_token are required" });
  }
  if (platform === "instagram" && !business_id) {
    return res.status(400).json({ error: "business_id is required for Instagram" });
  }
  try {
    const credentials = platform === "instagram" ? { access_token, business_id } : { access_token };
    const row = await upsertLinkedChannel({ platform, channel_key, label, handle, credentials });
    await logEvent("Channel Manager", `✓ ${platform === "instagram" ? "Instagram" : "TikTok"} channel linked: "${label}"`);
    res.json({ ok: true, channel: { key: row.channel_key, label: row.label, handle: row.handle } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/channels/:platform/:channelKey — unlink an account.
channelAuthRouter.delete("/channels/:platform/:channelKey", async (req, res) => {
  const { platform, channelKey } = req.params;
  if (!["youtube", "instagram", "tiktok"].includes(platform)) return res.status(400).json({ error: "Unknown platform" });
  try {
    await deleteLinkedChannel(platform, channelKey);
    await logEvent("Channel Manager", `Unlinked ${platform} channel "${channelKey}"`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
