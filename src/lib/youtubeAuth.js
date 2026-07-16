/**
 * One-time YouTube OAuth flow.
 * Run: npm run auth:youtube
 * Opens a consent URL; after approving, the refresh token is printed —
 * paste it into .env as GOOGLE_REFRESH_TOKEN.
 */
import { google } from "googleapis";
import http from "node:http";
import { config } from "../config.js";

const oauth2 = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/youtube.upload"],
});

console.log("\n1. Open this URL in your browser and approve access:\n");
console.log(url);
console.log("\n2. Waiting for the redirect on", config.google.redirectUri, "…\n");

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${config.port}`);
  if (u.pathname !== new URL(config.google.redirectUri).pathname) return;
  const code = u.searchParams.get("code");
  const { tokens } = await oauth2.getToken(code);
  res.end("Horizon AI authorized. You can close this tab.");
  console.log("\n✓ Success. Add this line to your .env:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  server.close();
  process.exit(0);
});
server.listen(config.port);
