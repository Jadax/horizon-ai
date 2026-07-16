-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — adds:
--   1. A `language` column (default 'en', supports 'hi' for Hindi —
--      ElevenLabs' multilingual model auto-detects language from script
--      text, no extra voice IDs needed).
--   2. A new "News" niche — catchy viral word-clip videos built from
--      real breaking/trending news, sourced from GDELT + Google News RSS
--      + Google Trends + YouTube Trending (all free, no-auth sources).
--   3. `wordClipMode` support in editing_style_preset — giant single-word/
--      short-phrase captions instead of the standard 2-3 word chunks,
--      for a punchier "viral word" aesthetic.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

alter table niche_configurations add column if not exists language text not null default 'en';

insert into niche_configurations
  (niche_name, target_sources, footage_keywords, rss_feeds, voice_profile_id, language, editing_style_preset)
values
(
  'News',
  '{}',  -- Reddit not used for this niche; GDELT/Google News/YouTube Trending cover it
  array[
    'breaking news studio','city skyline dramatic','newspaper close up',
    'live news ticker background','crowd protest news','world map digital',
    'server data center','stock market screen','clock ticking close up',
    'megaphone announcement','red alert abstract','satellite earth view'
  ],
  array[
    'https://feeds.bbci.co.uk/news/rss.xml',
    'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
    'https://moxie.foxnews.com/google-publisher/latest.xml'
  ],
  'onwK4e9ZLuTAKqWW03F9',  -- deep, urgent narrator voice
  'en',
  '{
    "caption": {"color":"#FF3B30","font":"Montserrat ExtraBold","position":"center","style":"word-clip"},
    "transitions":"fast-cut",
    "music_energy":"Suspense",
    "music_db":-17,
    "zoom":"kenburns-fast",
    "wordClipMode": true
  }'::jsonb
)
on conflict (niche_name) do update set
  rss_feeds = excluded.rss_feeds,
  footage_keywords = excluded.footage_keywords,
  editing_style_preset = excluded.editing_style_preset,
  language = excluded.language;

-- ── Optional: a Hindi-language variant of an existing niche ─────────────
-- Uncomment and run if you want a Hindi News/Aesthetic/etc channel variant
-- (each niche_name must stay unique, so name it distinctly, e.g. 'News (Hindi)'):
--
-- insert into niche_configurations
--   (niche_name, target_sources, footage_keywords, rss_feeds, voice_profile_id, language, editing_style_preset)
-- select
--   'News (Hindi)', target_sources, footage_keywords, rss_feeds, voice_profile_id, 'hi', editing_style_preset
-- from niche_configurations where niche_name = 'News'
-- on conflict (niche_name) do nothing;

-- ── Sanity check ──────────────────────────────────────────────────────
-- select niche_name, language, rss_feeds from niche_configurations;
