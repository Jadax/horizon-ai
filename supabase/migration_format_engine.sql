-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — Format Decision Engine + additional real gaming RSS feeds
-- (researched July 2026: GamesIndustry.biz, Shacknews, The Verge Games,
-- The Guardian Games, Game World Observer, Variety Gaming, TechCrunch
-- Gaming — all currently active publisher feeds, verified via search).
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

alter table pipeline_logs add column if not exists format_decision jsonb;

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
  ]
where niche_name = 'Gaming/Lore';

-- ── Sanity check ──────────────────────────────────────────────────────
-- select niche_name, array_length(rss_feeds,1) as feeds from niche_configurations
-- where niche_name = 'Gaming/Lore';
