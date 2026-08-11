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
import { google } from "googleapis";
import { config } from "../config.js";
import { logEvent } from "../supabase.js";
import { upsertLinkedChannel, deleteLinkedChannel, mergedChannelList } from "../lib/linkedChannels.js";

export const channelAuthRouter = express.Router();

function callbackUrl(req) {
  return `${req.protocol}://${req.get("host")}/api/auth/youtube/callback`;
}

// GET /api/auth/youtube/start — kicks off the Google consent screen. Called
// via a plain link/window.open from the dashboard (carries ?key= for auth
// since it's a full navigation, not a fetch with an Authorization header).
channelAuthRouter.get("/auth/youtube/start", (req, res) => {
  const channelKey = String(req.query.channel_key || "").trim();
  const label = String(req.query.label || "").trim();
  if (!channelKey || !label) return res.status(400).send("channel_key and label are required");

  const oauth2 = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, callbackUrl(req));
  const state = Buffer.from(JSON.stringify({ channelKey, label })).toString("base64url");
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    state,
  });
  res.redirect(url);
});

// GET /api/auth/youtube/callback — Google redirects here with ?code=&state=.
// Exempted from the dashboard-password auth middleware (see index.js) since
// Google's redirect carries no Authorization header; the OAuth code itself
// is the proof of a legitimate flow.
channelAuthRouter.get("/auth/youtube/callback", async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  const page = (title, body) => res.send(`<!doctype html><html><head><title>${title}</title>
    <style>body{font-family:system-ui,sans-serif;background:#0a0a12;color:#f1f5f9;display:flex;align-items:center;
    justify-content:center;height:100vh;margin:0}.box{text-align:center;max-width:420px;padding:32px}
    h1{font-size:18px}p{color:#9ba8c0;font-size:14px;line-height:1.6}</style></head>
    <body><div class="box"><h1>${title}</h1><p>${body}</p></div></body></html>`);

  if (oauthError) return page("Connection cancelled", `Google reported: ${oauthError}. You can close this tab.`);
  if (!code || !state) return page("Missing authorization", "No code/state received from Google. Close this tab and try again.");

  let channelKey, label;
  try {
    ({ channelKey, label } = JSON.parse(Buffer.from(String(state), "base64url").toString("utf8")));
  } catch {
    return page("Invalid request", "Could not read the linking request. Close this tab and try again.");
  }

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
