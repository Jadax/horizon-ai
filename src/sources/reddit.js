import Parser from 'rss-parser';

const UA = "HorizonAI/1.0 (autonomous content pipeline; contact via dashboard)";
const parser = new Parser({
  headers: { 'User-Agent': UA },
  timeout: 10000,
});

export async function fetchTopReddit(subreddit, limit = 15, sort = 'hot') {
  const cleanSub = subreddit.replace(/^r\//, '');
  const feedUrl = `https://www.reddit.com/r/${cleanSub}/${sort}.rss`;
  
  try {
    const feed = await parser.parseURL(feedUrl);
    return (feed.items || []).slice(0, limit).map((item) => ({
      title: item.title || '',
      url: item.link || '',
      selftext: item.contentSnippet || item.content || '',
      pubDate: item.pubDate ? new Date(item.pubDate).getTime() : Date.now(),
      score: 0,
      num_comments: 0,
    }));
  } catch (error) {
    throw new Error(`Reddit RSS (${cleanSub}) failed: ${error.message}`);
  }
}

export async function searchWiki(apiRoot, query) {
  const url = `${apiRoot}?action=query&list=search&srsearch=${encodeURIComponent(
    query
  )}&format=json&srlimit=3`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const json = await res.json();
  return (json?.query?.search || []).map((r) => ({
    title: r.title,
    snippet: r.snippet?.replace(/<[^>]+>/g, ""),
  }));
}