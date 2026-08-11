import { google } from "googleapis";
import { config } from "../config.js";
import { resolveYoutubeToken } from "./linkedChannels.js";

/**
 * Shared OAuth2 YouTube API client. Single source for the client factory
 * previously duplicated in agent5_upload.js and performanceTracker.js — both
 * upload and stats paths must talk to the SAME channel token the same way.
 * Async because the refresh token may live in Supabase (dashboard-linked
 * channel) rather than env vars — see lib/linkedChannels.js.
 */
export async function youtubeClient(channelKey = "primary") {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  const refreshToken = await resolveYoutubeToken(channelKey);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.youtube({ version: "v3", auth: oauth2 });
}
