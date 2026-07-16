-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — adds rss_feeds column and seeds real publisher RSS feeds
-- per niche. Reddit's unauthenticated .json access was shut down by
-- Reddit on May 28-30, 2026 (commercial API access now requires a
-- $12,000/year minimum commitment) — Agent 1 now treats these RSS feeds
-- as the PRIMARY topic source, with Reddit kept only as a harmless
-- best-effort bonus. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

alter table niche_configurations add column if not exists rss_feeds text[] not null default '{}';

update niche_configurations set rss_feeds = array[
  'https://www.ign.com/rss/articles/feed',
  'https://www.pcgamer.com/rss/',
  'https://www.eurogamer.net/feed'
] where niche_name = 'Gaming/Lore';

update niche_configurations set rss_feeds = array[
  'https://mymodernmet.com/feed/',
  'https://www.thisiscolossal.com/feed/'
] where niche_name = 'Aesthetic';

update niche_configurations set rss_feeds = array[
  'https://www.psychologytoday.com/intl/rss',
  'https://bigthink.com/feed/'
] where niche_name = 'Psychology';

update niche_configurations set rss_feeds = array[
  'https://www.lonelyplanet.com/rss',
  'https://feeds.bbci.co.uk/travel/rss.xml'
] where niche_name = 'Travel';

-- ── Sanity check — run after the above to confirm feeds are populated ───
-- select niche_name, rss_feeds from niche_configurations;

-- ── Notes ─────────────────────────────────────────────────────────────
-- These feed URLs were verified current as of July 2026, but RSS feed
-- URLs do occasionally change when a publisher redesigns their site.
-- If Agent 1's live status stream shows "RSS feed failed" warnings for a
-- specific URL, that feed likely moved — search "<publisher name> RSS
-- feed" to find the current URL and re-run an UPDATE for that niche.
-- Agent 1 degrades gracefully: a failed feed is skipped, not fatal, as
-- long as at least one source (another feed, Google Trends, or a lucky
-- Reddit response) returns candidates.
