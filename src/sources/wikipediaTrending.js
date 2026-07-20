/**
 * WIKIPEDIA TRENDING — Wikimedia's official pageviews REST API (free, no
 * key; only requires a descriptive User-Agent per their policy). Yesterday's
 * most-viewed articles are the single cleanest "what is the world curious
 * about right now" signal there is: no bots, no engagement farming, just
 * millions of humans looking something up. An article spiking here almost
 * always has a story behind it worth telling.
 */
import { UA } from "./rss.js";

// Namespace/utility pages that always top the chart but aren't topics.
const SKIP = /^(Main_Page|Special:|Wikipedia:|Portal:|Help:|File:|Talk:|User:|Template:|Category:|.*_\(disambiguation\))/;

export async function fetchWikipediaTrending(lang = "en", limit = 12) {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${lang}.wikipedia/all-access/${path}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Wikimedia pageviews → HTTP ${res.status}`);
  const json = await res.json();
  const articles = json.items?.[0]?.articles || [];
  return articles
    .filter((a) => !SKIP.test(a.article))
    .slice(0, limit)
    .map((a) => ({
      title: a.article.replace(/_/g, " ").slice(0, 200),
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(a.article)}`,
      selftext: "",
      pubDate: Date.now(),
      score: a.views || 0,
      num_comments: 0,
    }));
}
