/**
 * SOCIAL RSS COLLECTOR
 *
 * Platforms do not all expose a native public RSS API. Rather than scrape
 * pages or bypass login/paywalls, Horizon reads only public RSS/Atom feeds or
 * feeds the operator is authorised to access. This supports YouTube's native
 * channel Atom feeds and configurable, authorised RSS exports for Twitch, X
 * (Twitter), Kick, and any future platform.
 */
import { fetchRSSFeed } from "./rss.js";

const PLATFORM_NAMES = {
  youtube: "YouTube",
  twitch: "Twitch",
  twitter: "X/Twitter",
  x: "X/Twitter",
  kick: "Kick",
  generic: "Social RSS",
};

export function normaliseSocialFeeds(feeds) {
  if (!Array.isArray(feeds)) return [];
  return feeds
    .map((feed) => (typeof feed === "string" ? { platform: "generic", url: feed } : feed))
    .filter((feed) => feed && typeof feed.url === "string" && /^https?:\/\//i.test(feed.url))
    .map((feed) => ({
      platform: String(feed.platform || "generic").toLowerCase(),
      url: feed.url,
      label: feed.label || null,
      authKey: feed.auth_key || null,
    }));
}

export async function fetchSocialRSSFeeds(feeds, authorisedHeaders = {}, limit = 8) {
  const results = await Promise.allSettled(
    normaliseSocialFeeds(feeds).map(async (feed) => {
      const headers = feed.authKey ? authorisedHeaders[feed.authKey] || {} : {};
      const items = await fetchRSSFeed(feed.url, limit, headers);
      const platformName = PLATFORM_NAMES[feed.platform] || feed.platform;
      return {
        feed,
        source: feed.label ? `${platformName}: ${feed.label}` : `${platformName} RSS`,
        items,
      };
    })
  );
  return results.map((result) => (result.status === "fulfilled" ? result.value : { error: result.reason }));
}
