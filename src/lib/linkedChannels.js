/**
 * LINKED CHANNELS — per-channel YouTube/Instagram/TikTok credentials,
 * connected from the dashboard's Channel Manager and stored in Supabase
 * (`linked_channels` table) instead of env vars, so a new account can be
 * added on Cloud Run without a redeploy (the container filesystem doesn't
 * persist across restarts).
 *
 * Legacy env-based channels (GOOGLE_CHANNELS / INSTAGRAM_CHANNELS /
 * TIKTOK_CHANNELS, plus the single-account GOOGLE_REFRESH_TOKEN /
 * INSTAGRAM_ACCESS_TOKEN / TIKTOK_ACCESS_TOKEN) still work as a fallback so
 * existing deployments aren't broken — a DB row for the same channel_key
 * always wins.
 */
import { supabase } from "../supabase.js";
import { config } from "../config.js";

async function fetchRow(platform, channelKey) {
  const { data } = await supabase
    .from("linked_channels")
    .select("*")
    .eq("platform", platform)
    .eq("channel_key", channelKey)
    .maybeSingle();
  return data || null;
}

export async function listLinkedChannels(platform) {
  const { data, error } = await supabase
    .from("linked_channels")
    .select("*")
    .eq("platform", platform)
    .order("created_at");
  if (error) return [];
  return data || [];
}

export async function upsertLinkedChannel({ platform, channel_key, label, handle, credentials }) {
  const { data, error } = await supabase
    .from("linked_channels")
    .upsert(
      { platform, channel_key, label, handle: handle || null, credentials: credentials || {}, updated_at: new Date().toISOString() },
      { onConflict: "platform,channel_key" }
    )
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteLinkedChannel(platform, channelKey) {
  const { error } = await supabase.from("linked_channels").delete().eq("platform", platform).eq("channel_key", channelKey);
  if (error) throw new Error(error.message);
}

/** Every channel available for a platform: DB rows merged with legacy env
 * config (DB wins on key collision), for the dashboard's channel pickers. */
export async function mergedChannelList(platform) {
  const dbRows = await listLinkedChannels(platform);
  const dbKeys = new Set(dbRows.map((r) => r.channel_key));
  const out = dbRows.map((r) => ({ key: r.channel_key, label: r.label, handle: r.handle, source: "linked" }));

  if (platform === "youtube") {
    if (!dbKeys.has("primary") && config.google.refreshToken) {
      out.unshift({ key: "primary", label: "Primary (env)", source: "env" });
    } else if (!dbKeys.has("primary")) {
      out.unshift({ key: "primary", label: "Primary (not connected)", source: "none" });
    }
    for (const [key, val] of Object.entries(config.google.channels || {})) {
      if (dbKeys.has(key)) continue;
      out.push({ key, label: `${val.handle || val.label || key} (env)`, source: "env" });
    }
  } else if (platform === "instagram") {
    if (!dbKeys.has("__ig_primary")) {
      out.unshift({
        key: "__ig_primary",
        label: config.instagram.accessToken ? "Primary (env)" : "Primary (not connected)",
        source: config.instagram.accessToken ? "env" : "none",
      });
    }
    for (const [key, val] of Object.entries(config.instagramChannels || {})) {
      if (dbKeys.has(key)) continue;
      out.push({ key, label: `${val.handle || val.label || key} (env)`, source: "env" });
    }
  } else if (platform === "tiktok") {
    if (!dbKeys.has("__tt_primary")) {
      out.unshift({
        key: "__tt_primary",
        label: config.tiktok.accessToken ? "Primary (env)" : "Primary (not connected)",
        source: config.tiktok.accessToken ? "env" : "none",
      });
    }
    for (const [key, val] of Object.entries(config.tiktokChannels || {})) {
      if (dbKeys.has(key)) continue;
      out.push({ key, label: `${val.handle || val.label || key} (env)`, source: "env" });
    }
  }
  return out;
}

/** Resolves a YouTube refresh token for a channel key: linked_channels row
 * first, then legacy GOOGLE_CHANNELS env map, then GOOGLE_REFRESH_TOKEN for
 * "primary". Returns null if nothing is connected for that key. */
export async function resolveYoutubeToken(channelKey) {
  const key = channelKey || "primary";
  const row = await fetchRow("youtube", key);
  if (row?.credentials?.refresh_token) return row.credentials.refresh_token;
  if (key !== "primary" && config.google.channels[key]) return config.google.channels[key];
  if (key === "primary") return config.google.refreshToken || null;
  return null;
}

/** Resolves { accessToken, businessId } for an Instagram channel key. Falls
 * back to the single global INSTAGRAM_ACCESS_TOKEN/BUSINESS_ID for the
 * "__ig_primary" key (or when no per-niche channel is set at all). */
export async function resolveInstagramCreds(channelKey) {
  const key = channelKey || "__ig_primary";
  const row = await fetchRow("instagram", key);
  if (row?.credentials?.access_token) {
    return { accessToken: row.credentials.access_token, businessId: row.credentials.business_id || null };
  }
  if (key === "__ig_primary") {
    return config.instagram.accessToken ? { accessToken: config.instagram.accessToken, businessId: config.instagram.businessId } : null;
  }
  const legacy = config.instagramChannels?.[key];
  if (legacy?.access_token) return { accessToken: legacy.access_token, businessId: legacy.business_id || null };
  return null;
}

/** Resolves { accessToken } for a TikTok channel key, same fallback order
 * as Instagram. */
export async function resolveTiktokCreds(channelKey) {
  const key = channelKey || "__tt_primary";
  const row = await fetchRow("tiktok", key);
  if (row?.credentials?.access_token) return { accessToken: row.credentials.access_token };
  if (key === "__tt_primary") {
    return config.tiktok.accessToken ? { accessToken: config.tiktok.accessToken } : null;
  }
  const legacy = config.tiktokChannels?.[key];
  if (legacy?.access_token) return { accessToken: legacy.access_token };
  return null;
}
