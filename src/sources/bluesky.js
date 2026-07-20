/**
 * BLUESKY — the official public AppView API (public.api.bsky.app, no auth
 * needed for public feeds). The "What's Hot" algorithmic feed surfaces the
 * network's currently-viral posts. Post text is raw social content, so the
 * same hygiene as Mastodon applies: strip links, skip bot-ish and low-signal
 * posts, require enough text to actually be a topic.
 */
import { UA } from "./rss.js";

const WHATS_HOT = "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot";

function cleanText(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“]+|["'”]+$/g, "")
    .slice(0, 200);
}

export async function fetchBlueskyHot(limit = 15, minLikes = 200) {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(WHATS_HOT)}&limit=${Math.min(50, limit * 3)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Bluesky whats-hot → HTTP ${res.status}`);
  const json = await res.json();
  return (json.feed || [])
    .map((entry) => entry.post)
    .filter((post) => post && (post.likeCount || 0) >= minLikes)
    .map((post) => ({
      title: cleanText(post.record?.text),
      url: post.uri ? `https://bsky.app/profile/${post.author?.handle}/post/${post.uri.split("/").pop()}` : null,
      selftext: "",
      pubDate: post.record?.createdAt ? new Date(post.record.createdAt).getTime() : 0,
      score: (post.likeCount || 0) + (post.repostCount || 0),
      num_comments: post.replyCount || 0,
    }))
    .filter((item) => item.title.length >= 25)
    .slice(0, limit);
}
