-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — the "comprehensive workflow" expansion:
--   1. `lore_wiki_apis` — generalizes the old hardcoded Elden Ring wiki to
--      a configurable list per niche. Warhammer 40k lore now sources from
--      Lexicanum's real MediaWiki API.
--   2. `target_duration_min_seconds` / `target_duration_max_seconds` — lets
--      a niche run longer than the short-form default when the content
--      genuinely needs it (a deep Gaming/Lore story, a multi-step Food
--      recipe), while most niches stay TikTok/Shorts length.
--   3. `target_channel` — which YouTube channel (per config.js's
--      GOOGLE_CHANNELS) a niche uploads to, for running multiple channels
--      off one Horizon AI instance.
--   4. Performance-tracking columns on pipeline_logs (yt_views, yt_likes,
--      yt_comments, stats_updated_at) — populated by
--      src/lib/performanceTracker.js, feeding real performance back into
--      the trend-scoring engine.
--   5. A new **Viral/Memes** niche — sourced compliantly (topic/trend
--      discovery only; original narration + licensed stock or text-based
--      visuals, never re-embedding someone else's clip or meme image).
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

alter table niche_configurations add column if not exists lore_wiki_apis text[] not null default '{}';
alter table niche_configurations add column if not exists target_duration_min_seconds integer;
alter table niche_configurations add column if not exists target_duration_max_seconds integer;
alter table niche_configurations add column if not exists target_channel text not null default 'primary';

alter table pipeline_logs add column if not exists target_channel text default 'primary';
alter table pipeline_logs add column if not exists yt_views integer;
alter table pipeline_logs add column if not exists yt_likes integer;
alter table pipeline_logs add column if not exists yt_comments integer;
alter table pipeline_logs add column if not exists stats_updated_at timestamptz;

-- ── Gaming/Lore: add Warhammer 40k (Lexicanum) alongside Elden Ring ──────
update niche_configurations set
  lore_wiki_apis = array[
    'https://eldenring.wiki.gg/api.php',
    'https://wh40k.lexicanum.com/mediawiki/api.php'
  ],
  rss_feeds = array_cat(rss_feeds, array[
    'https://www.warhammer-community.com/feed/'
  ])
where niche_name = 'Gaming/Lore';

-- ── New niche: Viral / Memes ──────────────────────────────────────────────
-- Sourced from real trend/topic signals (what moment is blowing up right
-- now), turned into ORIGINAL narrated commentary over licensed stock or
-- text/word-clip visuals. Never re-embeds someone else's clip, screenshot,
-- or meme image — that keeps virality relevance without any copyright
-- exposure, the same principle already applied to every other niche here.
insert into niche_configurations
  (niche_name, target_sources, footage_keywords, rss_feeds, mastodon_tags, lemmy_communities,
   voice_profile_id, trend_region, language, target_duration_min_seconds, target_duration_max_seconds,
   editing_style_preset)
values
(
  'Viral',
  '{}',
  array[
    'crowd laughing reaction','phone screen close up hands','confused face reaction abstract',
    'internet cafe neon','meme text background blur','shocked reaction silhouette',
    'typing keyboard close up fast','scrolling phone social media blur','office chair spin fun',
    'party confetti celebration','trophy raised celebration','crowd cheering stadium'
  ],
  array[
    'https://knowyourmeme.com/newsfeed.rss'
  ],
  array['memes','funny','internetculture'],
  array['memes','funny'],
  'onwK4e9ZLuTAKqWW03F9',
  'US',
  'en',
  20,
  35,
  '{
    "caption": {"color":"#10B981","font":"Montserrat ExtraBold","position":"center","style":"word-clip"},
    "transitions":"fast-cut",
    "music_energy":"High",
    "music_db":-16,
    "zoom":"kenburns-fast",
    "wordClipMode": true
  }'::jsonb
)
on conflict (niche_name) do update set
  rss_feeds = excluded.rss_feeds,
  mastodon_tags = excluded.mastodon_tags,
  lemmy_communities = excluded.lemmy_communities;

-- ── Give Gaming/Lore and Food room to run longer when a topic needs it ──
-- (defaults elsewhere stay short-form; only set these where longer-form
-- genuinely fits the content type)
update niche_configurations set target_duration_min_seconds = 40, target_duration_max_seconds = 90
where niche_name = 'Gaming/Lore';

update niche_configurations set target_duration_min_seconds = 35, target_duration_max_seconds = 75
where niche_name = 'Food';

-- ── Sanity check ──────────────────────────────────────────────────────
-- select niche_name, target_channel, target_duration_min_seconds,
--        target_duration_max_seconds, lore_wiki_apis from niche_configurations;
