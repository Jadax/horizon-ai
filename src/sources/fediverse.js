/**
 * MASTODON — the fediverse's public hashtag/public timelines are open, no
 * auth, no key (unless an instance operator disables public preview, which
 * is rare and handled the same as any other source failure: logged, skipped).
 * A genuine hidden gem — most content pipelines default to Reddit/Twitter
 * and never look here, but it's real conversation data with zero paywall.
 * Rate limit: ~300 requests / 5 minutes per instance (documented by Mastodon).
 */
import { UA } from "./rss.js";

export async function fetchMastodonHashtag(tag, instance = "mastodon.social", limit = 10) {
  const url = `https://${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Mastodon #${tag}@${instance} → HTTP ${res.status}`);
  const json = await res.json();
  return (json || []).map((post) => ({
    title: (post.content || "").replace(/<[^>]+>/g, "").slice(0, 200),
    url: post.url || post.uri,
    selftext: "",
    pubDate: post.created_at ? new Date(post.created_at).getTime() : 0,
    score: (post.reblogs_count || 0) + (post.favourites_count || 0),
    num_comments: post.replies_count || 0,
  }));
}

/**
 * LEMMY — federated Reddit-alternative, fully open REST API, no auth
 * required for public listings. Good corroborating signal for topics
 * Reddit used to surface before its lockdown.
 */
export async function fetchLemmyHot(community, instance = "lemmy.world", limit = 10) {
  const url = `https://${instance}/api/v3/post/list?community_name=${encodeURIComponent(
    community
  )}&sort=Hot&limit=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Lemmy c/${community}@${instance} → HTTP ${res.status}`);
  const json = await res.json();
  return (json.posts || []).map((p) => ({
    title: p.post?.name || "",
    url: p.post?.url || p.post?.ap_id,
    selftext: (p.post?.body || "").slice(0, 1200),
    pubDate: p.post?.published ? new Date(p.post.published).getTime() : 0,
    score: p.counts?.score || 0,
    num_comments: p.counts?.comments || 0,
  }));
}
