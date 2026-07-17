-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — the big harvesting expansion:
--   1. `trend_rules` table — persisted, self-adjusting weights for the
--      trend-scoring engine (src/lib/trendScoring.js). Starts from
--      sensible defaults if empty; no seed rows required.
--   2. New niche_configurations columns: `mastodon_tags`, `lemmy_communities`
--      (fediverse hidden-gem sources), `trend_region` (per-niche country
--      code for Google Trends/YouTube Trending — lets India-focused niches
--      pull India-specific trending data instead of defaulting to US).
--   3. A much larger RSS feed set per existing niche, including real
--      India-focused publishers (Times of India, NDTV, Hindustan Times) —
--      India is the single largest Shorts-consuming market and was
--      previously entirely unaddressed.
--   4. A new **Food** niche — Japanese, Korean, and global food content,
--      sourced from real food-blog RSS feeds.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists trend_rules (
  rule_key text primary key,
  weight numeric not null,
  updated_at timestamptz not null default now()
);
alter table trend_rules enable row level security;

alter table niche_configurations add column if not exists mastodon_tags text[] not null default '{}';
alter table niche_configurations add column if not exists lemmy_communities text[] not null default '{}';
alter table niche_configurations add column if not exists trend_region text not null default 'US';

-- ── Expanded RSS + fediverse + region tuning for existing niches ─────────

update niche_configurations set
  rss_feeds = array[
    'https://www.ign.com/rss/articles/feed',
    'https://www.pcgamer.com/rss/',
    'https://www.eurogamer.net/feed',
    'https://www.rockpapershotgun.com/feed',
    'https://kotaku.com/rss',
    'https://www.polygon.com/rss/index.xml',
    'https://www.gamesradar.com/rss/',
    'https://www.dexerto.com/feed/',
    'https://dotesports.com/feed',
    'https://www.gamesindustry.biz/feed',
    'https://www.shacknews.com/feed/rss',
    'https://www.theverge.com/games/rss/index.xml',
    'https://www.theguardian.com/games/rss',
    'https://gameworldobserver.com/feed',
    'https://variety.com/v/gaming/feed/',
    'https://techcrunch.com/category/gaming/feed/'
  ],
  mastodon_tags = array['gaming','esports','pcgaming'],
  lemmy_communities = array['games','pcgaming']
where niche_name = 'Gaming/Lore';

update niche_configurations set
  rss_feeds = array[
    'https://mymodernmet.com/feed/',
    'https://www.thisiscolossal.com/feed/',
    'https://www.boredpanda.com/feed/',
    'https://petapixel.com/feed/',
    'https://www.designboom.com/feed/'
  ],
  mastodon_tags = array['photography','nature','art'],
  lemmy_communities = array['EarthPorn','pics']
where niche_name = 'Aesthetic';

update niche_configurations set
  rss_feeds = array[
    'https://www.psychologytoday.com/intl/rss',
    'https://bigthink.com/feed/',
    'https://www.scientificamerican.com/section/mind-and-brain/feed/',
    'https://www.theschooloflife.com/feed/',
    'https://fs.blog/feed/'
  ],
  mastodon_tags = array['psychology','philosophy'],
  lemmy_communities = array['philosophy','selfimprovement']
where niche_name = 'Psychology';

update niche_configurations set
  rss_feeds = array[
    'https://www.lonelyplanet.com/rss',
    'https://feeds.bbci.co.uk/travel/rss.xml',
    'https://www.afar.com/feeds/all',
    'https://www.cntraveler.com/feed/rss',
    'https://matadornetwork.com/feed/'
  ],
  mastodon_tags = array['travel','backpacking'],
  lemmy_communities = array['travel','solotravel']
where niche_name = 'Travel';

update niche_configurations set
  rss_feeds = array[
    'https://feeds.bbci.co.uk/news/rss.xml',
    'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
    'https://moxie.foxnews.com/google-publisher/latest.xml',
    -- India-focused (single largest Shorts-consuming market — previously unaddressed)
    'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
    'https://feeds.feedburner.com/ndtvnews-top-stories',
    'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml'
  ],
  mastodon_tags = array['news','worldnews'],
  lemmy_communities = array['worldnews','news']
where niche_name = 'News';

-- ── New niche: Food (Japanese, Korean, and global) ───────────────────────

insert into niche_configurations
  (niche_name, target_sources, footage_keywords, rss_feeds, mastodon_tags, lemmy_communities,
   voice_profile_id, trend_region, language, editing_style_preset)
values
(
  'Food',
  '{}',
  array[
    'ramen bowl steam close up','sushi chef hands','korean bbq grill sizzle',
    'street food night market asia','noodles slurp close up','kimchi jar close up',
    'wok fire cooking','tea ceremony japanese','tokyo street food stall',
    'seoul night market food','dumplings steaming close up','matcha pouring close up'
  ],
  array[
    'https://www.justonecookbook.com/feed/',
    'https://www.maangchi.com/feed',
    'https://www.seriouseats.com/feeds/all',
    'https://www.bonappetit.com/feed/rss',
    'https://www.koreanbapsang.com/feed'
  ],
  array['food','cooking','ramen'],
  array['food','FoodPorn'],
  'EXAVITQu4vr4xnSDxMaL',
  'US',
  'en',
  '{
    "caption": {"color":"#FFD166","font":"Poppins SemiBold","position":"bottom","style":"warm"},
    "transitions":"cross-dissolve",
    "music_energy":"Chill",
    "music_db":-15,
    "zoom":"kenburns-slow"
  }'::jsonb
)
on conflict (niche_name) do update set
  rss_feeds = excluded.rss_feeds,
  footage_keywords = excluded.footage_keywords,
  mastodon_tags = excluded.mastodon_tags,
  lemmy_communities = excluded.lemmy_communities;

-- ── Sanity check ──────────────────────────────────────────────────────
-- select niche_name, trend_region, array_length(rss_feeds,1) as feeds,
--        mastodon_tags, lemmy_communities from niche_configurations;
