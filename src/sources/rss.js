/**
 * RSS — generic publisher feed reader.
 *
 * Used for every real-world publisher feed (news, food blogs, gaming press,
 * travel, psychology, etc). Free, no auth, and structurally unlikely to
 * ever be locked down the way Reddit's unauthenticated API was (publishers
 * *want* their feeds consumed — see DEPLOYMENT_NOTES.md for that history).
 */
import Parser from "rss-parser";

const UA = "HorizonAI/1.0 (autonomous content pipeline; contact via dashboard)";
const parser = new Parser({ headers: { "User-Agent": UA }, timeout: 10000 });

/**
 * @param {string} feedUrl
 * @param {number} limit - max items to return
 * @returns {Promise<Array<{title,url,selftext,pubDate,score,num_comments}>>}
 */
export async function fetchRSSFeed(feedUrl, limit = 8) {
  const feed = await parser.parseURL(feedUrl);
  return (feed.items || []).slice(0, limit).map((item) => ({
    title: item.title || "",
    url: item.link || feedUrl,
    selftext: (item.contentSnippet || item.content || "").slice(0, 1200),
    pubDate: item.pubDate ? new Date(item.pubDate).getTime() : 0,
    score: 0,
    num_comments: 0,
  }));
}

export { UA };
