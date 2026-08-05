import { google } from "googleapis";
import { config, getChannelToken } from "../config.js";

/**
 * Shared OAuth2 YouTube API client. Single source for the client factory
 * previously duplicated in agent5_upload.js and performanceTracker.js — both
 * upload and stats paths must talk to the SAME channel token the same way.
 */
export function youtubeClient(channelKey = "primary") {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
  oauth2.setCredentials({ refresh_token: getChannelToken(channelKey) });
  return google.youtube({ version: "v3", auth: oauth2 });
}
