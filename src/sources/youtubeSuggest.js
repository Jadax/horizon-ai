/**
 * YOUTUBE SUGGEST SOURCE — free search-intent trend harvesting.
 *
 * Stolen from the growth-tools playbook (best-youtube-growth-tools): paid
 * keyword tools mine "how to / what is" YouTube search queries; the raw
 * autocomplete data is free from Google's unauthenticated suggest endpoint.
 * This gives search-intent topics our other sources miss — not what's being
 * posted, but what people are actively searching for in the niche.
 *
 * The endpoint is unofficial (no API key), so keep it polite: one request
 * per seed, short timeout, silent failure. It returns
 * [seed, [suggestion1, suggestion2, ...], ...] — we surface each suggestion
 * as a ranked candidate for the harvester.
 */
let lastRequestAt = 0;

async function fetchSuggestions(seed) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(seed)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json) && Array.isArray(json[1]) ? json[1].map(String).filter(Boolean).slice(0, 10) : [];
}

export async function fetchYouTubeSuggest(seeds, perSeed = 5) {
  const results = [];
  for (const raw of seeds.slice(0, 4)) {
    // 10s pacing between requests — same discipline as the Reddit .rss source
    const wait = lastRequestAt + 10000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    try {
      const suggestions = await fetchSuggestions(raw);
      for (const suggestion of suggestions.slice(0, perSeed)) {
        results.push({
          title: suggestion,
          url: `https://www.youtube.com/results?search_query=${encodeURIComponent(suggestion)}`,
          score: 100 - suggestion.length, // shorter, punchier queries read as broader searches
          _suggestSource: true,
        });
      }
    } catch {
      // autocomplete is best-effort — never fail a harvest over it
    }
  }
  return results;
}
