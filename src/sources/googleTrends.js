/**
 * GOOGLE TRENDS — official public RSS feed. Free, no auth.
 * Broad "what's culturally hot right now" signal, layered across every niche.
 */
import Parser from "rss-parser";
import { UA } from "./rss.js";

const parser = new Parser({ headers: { "User-Agent": UA }, timeout: 10000 });

/** @param {string} geo - two-letter country code, e.g. "US", "IN", "JP", "KR" */
export async function fetchGoogleTrends(geo = "US") {
  const feedUrl = `https://trends.google.com/trending/rss?geo=${geo}`;
  const feed = await parser.parseURL(feedUrl);
  return (feed.items || []).slice(0, 10).map((item) => ({
    title: item.title || "",
    url: item.link || feedUrl,
    selftext: (item.contentSnippet || item.content || "").slice(0, 800),
    pubDate: item.pubDate ? new Date(item.pubDate).getTime() : 0,
    score: 0,
    num_comments: 0,
    isGoogleTrend: true,
  }));
}

/**
 * GOOGLE NEWS RSS — free, no auth, no key.
 * @param {string|null} query - null = general top-stories feed for the region
 * @param {string} hl - language, e.g. "en-US", "hi-IN"
 * @param {string} gl - country, e.g. "US", "IN"
 */
export async function fetchGoogleNews(query, hl = "en-US", gl = "US") {
  const feedUrl = query
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`
    : `https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`;
  const feed = await parser.parseURL(feedUrl);
  return (feed.items || []).slice(0, 10).map((item) => ({
    title: item.title || "",
    url: item.link || feedUrl,
    selftext: (item.contentSnippet || item.content || "").slice(0, 800),
    pubDate: item.pubDate ? new Date(item.pubDate).getTime() : 0,
    score: 0,
    num_comments: 0,
  }));
}
