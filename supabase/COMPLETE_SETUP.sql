-- ═══════════════════════════════════════════════════════════════════════
-- HORIZON AI — COMPLETE SUPABASE SETUP
-- One file, run once. Combines everything from schema.sql through
-- migration_feed_library.sql into a single ordered script.
-- Every statement here is idempotent (if not exists / on conflict do
-- nothing/update) — safe to run multiple times if you're ever unsure
-- whether it already ran.
--
-- Individual migration files are kept in this folder for reference /
-- changelog purposes, but you only need to run THIS file going forward.
-- ═══════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: schema.sql
-- ═══════════════════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════════════════
-- HORIZON AI — Supabase Postgres schema
-- Run in the Supabase SQL editor.
--
-- NOTE ON RLS: RLS stays ENABLED. The backend uses the service-role key,
-- which bypasses RLS automatically — same agent access, but the tables
-- are not left open to the public anon key.
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ── 1. Niche configurations ─────────────────────────────────────────────
create table if not exists niche_configurations (
  id uuid primary key default gen_random_uuid(),
  niche_name text not null unique,
  active boolean not null default true,
  -- text/topic sources the harvester reads (subreddit names, wiki API roots, RSS)
  target_sources text[] not null default '{}',
  -- search terms used against Pexels/Pixabay to find licensed b-roll
  footage_keywords text[] not null default '{}',
  -- publisher RSS feeds — the PRIMARY topic source since Reddit's
  -- unauthenticated .json access was deprecated May 2026 (see
  -- DEPLOYMENT_NOTES.md and migration_rss_feeds.sql)
  rss_feeds text[] not null default '{}',
  voice_profile_id text not null,
  -- 'en' or 'hi' — ElevenLabs' multilingual model auto-detects language
  -- from the script text, no separate voice IDs needed per language
  language text not null default 'en',
  editing_style_preset jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table niche_configurations enable row level security;

-- ── 2. Music library ─────────────────────────────────────────────────────
create table if not exists music_library (
  id uuid primary key default gen_random_uuid(),
  track_url text not null,        -- public MP3 in Supabase Storage
  title text,
  genre text,
  energy_level text check (energy_level in ('High','Suspense','Chill','Wonder')),
  license_note text,              -- keep provenance: where the track came from
  created_at timestamptz not null default now()
);

alter table music_library enable row level security;

-- ── 3. Pipeline logs ──────────────────────────────────────────────────────
create table if not exists pipeline_logs (
  id uuid primary key default gen_random_uuid(),
  niche text not null,
  topic text,
  source_url text,                 -- the wiki page / reddit thread that inspired the topic
  sourced_media_urls jsonb,        -- array of licensed stock clip URLs used
  script text,
  calculated_trim_points jsonb,    -- per-clip: [{"url":"...","start":2.0,"length":6.5}, ...]
  voiceover_url text,
  music_track_id uuid references music_library(id),
  shotstack_render_id text,
  rendered_video_url text,
  youtube_video_id text,
  title text,
  title_reasoning text,  -- internal note: which hook/pattern was used and why (never shown to viewers)
  description text,
  tags text[],
  status text not null default 'Queued',
  -- 'Queued' → 'Sourcing' → 'Scripting' → 'Synthesizing' → 'Rendering'
  -- → 'Rendered' → 'Awaiting Approval' → 'Scheduled' → 'Failed'
  error text,
  target_region text,
  publish_schedule timestamptz,
  -- usage/cost tracking (approximate; see DEPLOYMENT_NOTES.md for rate assumptions)
  openai_tokens integer default 0,
  elevenlabs_characters integer default 0,
  shotstack_render_seconds numeric default 0,
  created_at timestamptz not null default now()
);

alter table pipeline_logs enable row level security;

create index if not exists idx_pipeline_logs_status on pipeline_logs (status);
create index if not exists idx_pipeline_logs_created on pipeline_logs (created_at desc);

-- ── Seed: the four niches ────────────────────────────────────────────────
insert into niche_configurations
  (niche_name, target_sources, footage_keywords, voice_profile_id, editing_style_preset)
values
(
  'Gaming/Lore',
  array['r/gamingsuggestions','r/Eldenring','r/fromsoftware','r/gaming'],
  array['dark fantasy landscape','gothic castle','medieval ruins','fog forest cinematic','armor knight'],
  'onwK4e9ZLuTAKqWW03F9',  -- ElevenLabs "Daniel" — deep cinematic narrator (swap freely)
  '{
    "caption": {"color":"#10B981","font":"Montserrat ExtraBold","position":"center","style":"heavy-sans"},
    "transitions":"fast-cut",
    "music_energy":"High",
    "music_db":-18,
    "zoom":"kenburns-fast"
  }'::jsonb
),
(
  'Aesthetic',
  array['r/oddlysatisfying','r/CozyPlaces','r/EarthPorn'],
  array['cinematic landscape drone','ocean waves slow motion','misty mountains','city rain window','clouds timelapse'],
  'EXAVITQu4vr4xnSDxMaL',  -- ElevenLabs "Sarah" — soft calm voice
  '{
    "caption": {"color":"#FFFFFF","font":"Inter Light","position":"bottom","style":"minimal"},
    "transitions":"cross-dissolve",
    "music_energy":"Chill",
    "music_db":-14,
    "zoom":"kenburns-slow"
  }'::jsonb
),
(
  'Psychology',
  array['r/psychology','r/DecidingToBeBetter','r/getdisciplined'],
  array['person thinking silhouette','brain abstract','rain window contemplative','walking alone city night','minimal abstract shapes'],
  'EXAVITQu4vr4xnSDxMaL',
  '{
    "caption": {"color":"#FFFFFF","font":"Inter Light","position":"bottom","style":"minimal"},
    "transitions":"cross-dissolve",
    "music_energy":"Suspense",
    "music_db":-16,
    "zoom":"kenburns-slow"
  }'::jsonb
),
(
  'Travel',
  array['r/travel','r/solotravel','r/backpacking'],
  array['tropical beach drone','old town europe street','night market asia','safari sunset','mountain road aerial'],
  'onwK4e9ZLuTAKqWW03F9',
  '{
    "caption": {"color":"#FFD166","font":"Poppins SemiBold","position":"center","style":"warm"},
    "transitions":"fast-cut",
    "music_energy":"Wonder",
    "music_db":-16,
    "zoom":"kenburns-fast"
  }'::jsonb
)
on conflict (niche_name) do nothing;

-- ── Follow-up migrations for a fully fresh setup ─────────────────────────
-- Run these two files after this one to get the RSS-based topic sources
-- and the News niche (both were added after this base schema; see
-- DEPLOYMENT_NOTES.md for why):
--   supabase/migration_rss_feeds.sql   — populates rss_feeds per niche
--   supabase/migration_news_niche.sql  — adds the News/word-clip niche

-- ── Storage bucket for music (create via dashboard or API) ──────────────
-- Bucket: "music" (public). Upload royalty-free tracks and insert rows into
-- music_library with the public URL and a license_note recording the source.

-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — run this once if your project already existed before the
-- usage/cost tracking columns were added. Safe to re-run (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════
alter table pipeline_logs add column if not exists openai_tokens integer default 0;
alter table pipeline_logs add column if not exists elevenlabs_characters integer default 0;
alter table pipeline_logs add column if not exists shotstack_render_seconds numeric default 0;
alter table pipeline_logs add column if not exists title_reasoning text;


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_rss_feeds.sql
-- ═══════════════════════════════════════════════════════════════════════
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


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_news_niche.sql
-- ═══════════════════════════════════════════════════════════════════════
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


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_title_reasoning.sql
-- ═══════════════════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — adds title_reasoning column. Agent 2's system prompt now
-- follows an explicit titling process (identify the one concrete hook in
-- the script → pick a matching proven pattern → calibrate for a
-- tech-savvy audience → verify the title's claim actually appears in the
-- script) and returns a short note explaining its choice. This column
-- stores that note for operator review in the dashboard — it is never
-- shown to viewers, purely a quality-check tool for you.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

alter table pipeline_logs add column if not exists title_reasoning text;


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_expand_sources.sql
-- ═══════════════════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — expands target_sources (topic harvesting) and
-- footage_keywords (stock footage variety) per niche. Safe to re-run;
-- uses UPDATE so it refreshes existing rows rather than skipping them.
--
-- NOTE ON SCOPE: footage sourcing stays on Pexels + Pixabay only — these
-- are the only stock-video providers with public APIs licensed for this
-- kind of automated use. Sites like Coverr/Mixkit/Videezy don't expose
-- APIs for bulk automated fetching, and scraping them would carry the
-- same ToS risk we specifically designed around for gameplay footage.
-- What's expanded here is the *breadth* of search terms and topic
-- sources within that same safe footprint.
-- ═══════════════════════════════════════════════════════════════════════

update niche_configurations set
  target_sources = array[
    'r/gamingsuggestions','r/Eldenring','r/fromsoftware','r/gaming',
    'r/darksouls3','r/bloodborne','r/Fallout','r/skyrim','r/masseffect',
    'r/zelda','r/GamingLeaksAndRumours'
  ],
  footage_keywords = array[
    'dark fantasy landscape','gothic castle','medieval ruins','fog forest cinematic',
    'armor knight','ancient stone architecture','torch fire dark hallway',
    'stormy castle ruins','wasteland desert cinematic','abandoned bunker interior',
    'snowy mountain fortress','cathedral interior dramatic light'
  ]
where niche_name = 'Gaming/Lore';

update niche_configurations set
  target_sources = array[
    'r/oddlysatisfying','r/CozyPlaces','r/EarthPorn','r/SkyPorn',
    'r/WaterPorn','r/slowtv','r/NatureIsFuckingLit','r/ExposurePorn'
  ],
  footage_keywords = array[
    'cinematic landscape drone','ocean waves slow motion','misty mountains',
    'city rain window','clouds timelapse','forest sunlight rays',
    'lake reflection calm','autumn leaves falling','desert dunes aerial',
    'waterfall slow motion','snow falling forest','golden hour field'
  ]
where niche_name = 'Aesthetic';

update niche_configurations set
  target_sources = array[
    'r/psychology','r/DecidingToBeBetter','r/getdisciplined','r/Stoicism',
    'r/selfimprovement','r/socialskills','r/philosophy'
  ],
  footage_keywords = array[
    'person thinking silhouette','brain abstract','rain window contemplative',
    'walking alone city night','minimal abstract shapes','empty room natural light',
    'clock time lapse','crowd blurred motion','solitary figure horizon',
    'candle flame close up','journal writing hands','city lights night bokeh'
  ]
where niche_name = 'Psychology';

update niche_configurations set
  target_sources = array[
    'r/travel','r/solotravel','r/backpacking','r/digitalnomad',
    'r/travelhacks','r/shoestring','r/onebag'
  ],
  footage_keywords = array[
    'tropical beach drone','old town europe street','night market asia',
    'safari sunset','mountain road aerial','train window countryside',
    'airport terminal walking','street food vendor','rooftop city skyline',
    'boat ocean island','hiking trail viewpoint','local market colorful stalls'
  ]
where niche_name = 'Travel';


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_harvesting_expansion.sql
-- ═══════════════════════════════════════════════════════════════════════
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


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_comprehensive_expansion.sql
-- ═══════════════════════════════════════════════════════════════════════
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


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_format_engine.sql
-- ═══════════════════════════════════════════════════════════════════════
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


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_quality_cost_niches.sql
-- ═══════════════════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — cost/quality fixes + India News niche + Mindful/Calm niche
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

-- Columns needed for the new "Render Production" feature (re-render an
-- approved job at full quality without re-calling any paid API)
alter table pipeline_logs add column if not exists voiceover_words jsonb;
alter table pipeline_logs add column if not exists duration_seconds numeric;
alter table pipeline_logs add column if not exists music_track_url text;
alter table pipeline_logs add column if not exists preset_snapshot jsonb;

-- Viral MUST be 20-30s max per your explicit direction on viral length
update niche_configurations set target_duration_min_seconds = 20, target_duration_max_seconds = 30
where niche_name = 'Viral';

-- ── New niche: News India ────────────────────────────────────────────────
-- Dedicated India-focused news niche (distinct from the general News
-- niche) — India Today, ABP Live, Times of India, NDTV, Hindustan Times.
-- English by default per your preference; language can be flipped to 'hi'
-- later for a Hindi variant without re-architecting anything.
insert into niche_configurations
  (niche_name, target_sources, footage_keywords, rss_feeds, mastodon_tags, lemmy_communities,
   voice_profile_id, trend_region, language, target_duration_min_seconds, target_duration_max_seconds,
   editing_style_preset)
values
(
  'News India',
  '{}',
  array[
    'india flag waving','mumbai city skyline','delhi street traffic aerial',
    'indian parliament building','crowd protest india','stock market screen india',
    'cricket stadium crowd india','indian train station platform','monsoon rain india street',
    'temple architecture india','indian market vendors street','city lights night india'
  ],
  array[
    'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
    'https://feeds.feedburner.com/ndtvnews-top-stories',
    'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml',
    'https://www.indiatoday.in/rss/home',
    'https://news.abplive.com/home/feed'
  ],
  array['india','news'],
  array['india','worldnews'],
  'onwK4e9ZLuTAKqWW03F9',
  'IN',
  'en',
  20,
  30,
  '{
    "caption": {"color":"#FF9933","font":"Montserrat ExtraBold","position":"center","style":"word-clip"},
    "transitions":"fast-cut","music_energy":"Suspense","music_db":-17,"zoom":"kenburns-fast",
    "wordClipMode": true
  }'::jsonb
)
on conflict (niche_name) do update set
  rss_feeds = excluded.rss_feeds, footage_keywords = excluded.footage_keywords,
  mastodon_tags = excluded.mastodon_tags, lemmy_communities = excluded.lemmy_communities,
  trend_region = excluded.trend_region;

-- ── New niche: Mindful / Calm ─────────────────────────────────────────────
-- Distinct from the existing analytical "Psychology" niche — this one is
-- feel-good, meditative, gentle-pacing content: "breathe with me," "stop
-- scrolling for 20 seconds," content for people with busy/anxious minds.
-- word_clip_mode off by default (slow, spoken, not punchy); soft voice;
-- very slow cross-dissolve; chill music.
insert into niche_configurations
  (niche_name, target_sources, footage_keywords, rss_feeds, mastodon_tags, lemmy_communities,
   voice_profile_id, trend_region, language, target_duration_min_seconds, target_duration_max_seconds,
   editing_style_preset)
values
(
  'Mindful/Calm',
  '{}',
  array[
    'slow breathing exercise calm','soft morning light bedroom','gentle rain window cozy',
    'still water lake reflection','candle flame soft glow','cozy blanket window light',
    'slow motion clouds sky','quiet forest path morning','warm tea steam close up',
    'soft focus nature bokeh','gentle waves shore slow','sunlight through curtains'
  ],
  array[
    'https://www.mindful.org/feed/',
    'https://tinybuddha.com/feed/',
    'https://positivepsychology.com/feed/'
  ],
  array['mindfulness','mentalhealth','selfcare'],
  array['getdisciplined','Meditation'],
  'EXAVITQu4vr4xnSDxMaL',
  'US',
  'en',
  25,
  45,
  '{
    "caption": {"color":"#FFFFFF","font":"Inter Light","position":"bottom","style":"minimal"},
    "transitions":"cross-dissolve","music_energy":"Chill","music_db":-20,"zoom":"kenburns-slow",
    "wordClipMode": false
  }'::jsonb
)
on conflict (niche_name) do update set
  rss_feeds = excluded.rss_feeds, footage_keywords = excluded.footage_keywords,
  mastodon_tags = excluded.mastodon_tags, lemmy_communities = excluded.lemmy_communities;

-- ── Sanity check ──────────────────────────────────────────────────────
-- select niche_name, target_duration_min_seconds, target_duration_max_seconds,
--        trend_region, array_length(rss_feeds,1) as feeds
-- from niche_configurations order by niche_name;


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_more_rss_sources.sql
-- ═══════════════════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — additional real, verified RSS feeds for Psychology and
-- Mindful/Calm (researched via web search, all currently-active publisher
-- feeds — no scraping, no unauthorized access, same standard as every
-- other source in this project).
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

update niche_configurations set
  rss_feeds = array[
    'https://www.psychologytoday.com/intl/rss',
    'https://bigthink.com/feed/',
    'https://www.scientificamerican.com/section/mind-and-brain/feed/',
    'https://www.theschooloflife.com/feed/',
    'https://fs.blog/feed/',
    'https://feeds.feedburner.com/MarcAndAngel',
    'https://waitbutwhy.com/feed',
    'https://www.spring.org.uk/feed',
    'https://psychcentral.com/feed',
    'https://thoughtcatalog.com/feed/'
  ]
where niche_name = 'Psychology';

update niche_configurations set
  rss_feeds = array[
    'https://www.mindful.org/feed/',
    'https://tinybuddha.com/feed/',
    'https://positivepsychology.com/feed/',
    'https://feeds.feedburner.com/MarcAndAngel'
  ]
where niche_name = 'Mindful/Calm';

-- ── Sanity check ──────────────────────────────────────────────────────
-- select niche_name, array_length(rss_feeds,1) as feeds from niche_configurations
-- where niche_name in ('Psychology','Mindful/Calm');


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_more_rss_batch2.sql
-- ═══════════════════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — additional real, verified RSS feeds for Travel, Aesthetic,
-- and Viral (researched via web search, all currently-active publisher
-- feeds, same standard as every other source in this project — no
-- scraping, no unauthorized access).
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

update niche_configurations set
  rss_feeds = array[
    'https://www.lonelyplanet.com/rss',
    'https://feeds.bbci.co.uk/travel/rss.xml',
    'https://www.afar.com/feeds/all',
    'https://www.cntraveler.com/feed/rss',
    'https://matadornetwork.com/feed/',
    'https://blog.ricksteves.com/feed/',
    'https://www.nomadicmatt.com/travel-blog/feed/',
    'https://www.adventurouskate.com/feed/',
    'https://theworldtravelguy.com/feed/',
    'https://expertvagabond.com/feed/'
  ]
where niche_name = 'Travel';

update niche_configurations set
  rss_feeds = array[
    'https://mymodernmet.com/feed/',
    'https://www.thisiscolossal.com/feed/',
    'https://www.boredpanda.com/feed/',
    'https://petapixel.com/feed/',
    'https://www.designboom.com/feed/',
    'https://www.ignant.com/feed/',
    'https://designtaxi.com/news.rss'
  ]
where niche_name = 'Aesthetic';

update niche_configurations set
  rss_feeds = array[
    'https://knowyourmeme.com/newsfeed.rss',
    'https://digg.com/feed',
    'https://www.boredpanda.com/feed/',
    'https://www.mentalfloss.com/feed'
  ]
where niche_name = 'Viral';

-- ── Sanity check ──────────────────────────────────────────────────────
-- select niche_name, array_length(rss_feeds,1) as feeds from niche_configurations
-- where niche_name in ('Travel','Aesthetic','Viral');


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_awesome_rss_feeds.sql
-- ═══════════════════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — feeds sourced from plenaryapp/awesome-rss-feeds, a genuinely
-- open GitHub repo (curated for an open-source RSS reader app, MIT-style
-- use) — not scraped, just a public list of other publishers' own RSS
-- feeds, same category as every other source already in this project.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

update niche_configurations set
  rss_feeds = array[
    'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
    'https://feeds.feedburner.com/ndtvnews-top-stories',
    'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml',
    'https://www.indiatoday.in/rss/home',
    'https://news.abplive.com/home/feed',
    'https://feeds.bbci.co.uk/news/world/asia/india/rss.xml',
    'https://www.theguardian.com/world/india/rss',
    'https://www.thehindu.com/feeder/default.rss',
    'https://indianexpress.com/print/front-page/feed/',
    'https://www.news18.com/rss/world.xml',
    'https://www.firstpost.com/rss/india.xml',
    'https://www.business-standard.com/rss/home_page_top_stories.rss',
    'https://economictimes.indiatimes.com/rssfeedsdefault.cms',
    'http://feeds.feedburner.com/ScrollinArticles.rss',
    'https://theprint.in/feed/'
  ]
where niche_name = 'News India';

update niche_configurations set
  rss_feeds = array[
    'https://www.justonecookbook.com/feed/',
    'https://www.maangchi.com/feed',
    'https://www.seriouseats.com/feeds/all',
    'https://www.bonappetit.com/feed/rss',
    'https://www.koreanbapsang.com/feed',
    'http://feeds.feedburner.com/smittenkitchen',
    'https://www.thekitchn.com/main.rss',
    'http://www.loveandlemons.com/feed/',
    'https://www.davidlebovitz.com/feed/',
    'http://budgetbytes.blogspot.com/feeds/posts/default',
    'http://feeds.feedburner.com/food52-TheAandMBlog'
  ]
where niche_name = 'Food';

update niche_configurations set
  rss_feeds = array[
    'https://knowyourmeme.com/newsfeed.rss',
    'https://digg.com/feed',
    'https://www.boredpanda.com/feed/',
    'https://www.mentalfloss.com/feed',
    'https://xkcd.com/rss.xml',
    'https://www.theonion.com/rss',
    'http://feeds.feedburner.com/CrackedRSS',
    'http://feeds.feedburner.com/failblog'
  ]
where niche_name = 'Viral';

-- ── Sanity check ──────────────────────────────────────────────────────
-- select niche_name, array_length(rss_feeds,1) as feeds from niche_configurations
-- where niche_name in ('News India','Food','Viral');


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_awesome_rss_batch2.sql
-- ═══════════════════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — further mining of plenaryapp/awesome-rss-feeds: Photography
-- (→ Aesthetic), Gaming (→ Gaming/Lore), Travel additions. All fetched and
-- verified directly from the repo's raw OPML files.
--
-- NOTE: this repo's Gaming.opml and News.opml both include Reddit-hosted
-- RSS entries (r/gaming.rss, r/worldnews.rss). These are deliberately
-- EXCLUDED here, consistent with everything already discussed in this
-- project about Reddit access — a .rss extension on a reddit.com URL is
-- still automated access to Reddit's service, not a different category
-- of source just because the format differs from .json or HTML.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════

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
    'https://techcrunch.com/category/gaming/feed/',
    'https://www.gamespot.com/feeds/mashup/',
    'https://store.steampowered.com/feeds/news.xml',
    'https://indiegamesplus.com/feed',
    'http://feeds.feedburner.com/psblog',
    'https://www.escapistmagazine.com/v2/feed/'
  ]
where niche_name = 'Gaming/Lore';

update niche_configurations set
  rss_feeds = array[
    'https://mymodernmet.com/feed/',
    'https://www.thisiscolossal.com/feed/',
    'https://www.boredpanda.com/feed/',
    'https://petapixel.com/feed/',
    'https://www.designboom.com/feed/',
    'https://www.ignant.com/feed/',
    'https://designtaxi.com/news.rss',
    'https://iso.500px.com/feed/',
    'https://feeds.feedburner.com/DigitalPhotographySchool',
    'https://www.lightstalking.com/feed/',
    'https://stuckincustoms.com/feed/'
  ]
where niche_name = 'Aesthetic';

update niche_configurations set
  rss_feeds = array[
    'https://www.lonelyplanet.com/rss',
    'https://feeds.bbci.co.uk/travel/rss.xml',
    'https://www.afar.com/feeds/all',
    'https://www.cntraveler.com/feed/rss',
    'https://matadornetwork.com/feed/',
    'https://blog.ricksteves.com/feed/',
    'https://www.nomadicmatt.com/travel-blog/feed/',
    'https://www.adventurouskate.com/feed/',
    'https://theworldtravelguy.com/feed/',
    'https://expertvagabond.com/feed/',
    'https://www.atlasobscura.com/feeds/latest',
    'https://rss.nytimes.com/services/xml/rss/nyt/Travel.xml',
    'https://www.theguardian.com/uk/travel/rss'
  ]
where niche_name = 'Travel';

-- ── News niche gets the world-focused feeds from the repo's News category ──
update niche_configurations set
  rss_feeds = array_cat(rss_feeds, array[
    'http://feeds.bbci.co.uk/news/world/rss.xml',
    'http://rss.cnn.com/rss/edition_world.rss',
    'http://feeds.washingtonpost.com/rss/world'
  ])
where niche_name = 'News' and not ('http://feeds.bbci.co.uk/news/world/rss.xml' = any(rss_feeds));

-- ── Sanity check ──────────────────────────────────────────────────────
-- select niche_name, array_length(rss_feeds,1) as feeds from niche_configurations
-- where niche_name in ('Gaming/Lore','Aesthetic','Travel','News');


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_feed_library.sql
-- ═══════════════════════════════════════════════════════════════════════
-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — feed_library: a general-purpose store of EVERY RSS feed
-- discovered, independent of whether it's wired into an active niche.
--
-- WHY THIS TABLE EXISTS (separate from niche_configurations.rss_feeds):
-- niche_configurations.rss_feeds is the LIVE, ACTIVE list Agent 1 actually
-- queries for a running niche. feed_library is the full reference
-- database — every feed found, including ones with no current niche
-- (Sports, Business, Movies, Science, History, etc.) — so nothing
-- discovered is lost even if it isn't wired into the pipeline today.
-- A feed can be promoted from feed_library into a niche's rss_feeds at
-- any time by adding it to that niche's array; nothing here runs
-- automatically just by being stored.
--
-- Sourced primarily from plenaryapp/awesome-rss-feeds (github.com/
-- plenaryapp/awesome-rss-feeds), a genuinely open, MIT-style curated feed
-- list built for an open-source Android RSS reader — every URL below was
-- fetched and verified directly from that repo's raw OPML files, not
-- guessed. A handful of Reddit-hosted feed entries present in the source
-- repo (e.g. reddit.com/r/gaming.rss) were deliberately excluded — see
-- DEPLOYMENT_NOTES.md for why Reddit access of any format/endpoint is
-- treated as off-limits in this project.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists feed_library (
  id uuid primary key default gen_random_uuid(),
  category text not null,        -- e.g. 'Sports', 'Business & Economy', 'History'
  title text not null,
  feed_url text not null unique,
  source_repo text default 'plenaryapp/awesome-rss-feeds',
  linked_niche text,              -- if/when promoted into an active niche, record which one
  created_at timestamptz not null default now()
);
alter table feed_library enable row level security;
create index if not exists idx_feed_library_category on feed_library (category);

insert into feed_library (category, title, feed_url) values
-- ── Cricket ──────────────────────────────────────────────────────────
('Cricket', 'BBC Sport Cricket', 'http://feeds.bbci.co.uk/sport/cricket/rss.xml'),
('Cricket', 'ESPN Cricinfo', 'http://www.espncricinfo.com/rss/content/story/feeds/0.xml'),
('Cricket', 'Wisden', 'https://www.wisden.com/feed'),
('Cricket', 'The Guardian Cricket', 'https://www.theguardian.com/sport/cricket/rss'),
('Cricket', 'The Indian Express Cricket', 'https://indianexpress.com/section/sports/cricket/feed/'),
('Cricket', 'Times of India Cricket', 'https://timesofindia.indiatimes.com/rssfeeds/54829575.cms'),
('Cricket', 'The Roar Cricket', 'https://www.theroar.com.au/cricket/feed/'),
('Cricket', 'NDTV Sports Cricket', 'http://feeds.feedburner.com/ndtvsports-cricket'),

-- ── Business & Economy ──────────────────────────────────────────────────
('Business & Economy', 'Investing.com News', 'https://www.investing.com/rss/news.rss'),
('Business & Economy', 'Forbes Business', 'https://www.forbes.com/business/feed/'),
('Business & Economy', 'Fortune', 'https://fortune.com/feed'),
('Business & Economy', 'Harvard Business Review IdeaCast', 'http://feeds.harvardbusiness.org/harvardbusiness/ideacast'),
('Business & Economy', 'Business Standard', 'https://www.business-standard.com/rss/home_page_top_stories.rss'),
('Business & Economy', 'How I Built This (NPR)', 'https://feeds.npr.org/510313/podcast.xml'),
('Business & Economy', 'CNBC US Top News', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'),
('Business & Economy', 'Yahoo Finance', 'https://finance.yahoo.com/news/rssindex'),
('Business & Economy', 'Tim Ferriss Blog', 'https://tim.blog/feed/'),
('Business & Economy', 'Economic Times', 'https://economictimes.indiatimes.com/rssfeedsdefault.cms'),

-- ── Sports (general) ─────────────────────────────────────────────────────
('Sports', 'Yahoo Sports', 'https://sports.yahoo.com/rss/'),
('Sports', 'BBC Sport', 'http://feeds.bbci.co.uk/sport/rss.xml'),
('Sports', 'CNN Sport', 'http://rss.cnn.com/rss/edition_sport.rss'),
('Sports', 'NYT Sports', 'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml'),
('Sports', 'The Guardian Sport', 'https://www.theguardian.com/uk/sport/rss'),
('Sports', 'Sky News Sports', 'http://feeds.skynews.com/feeds/rss/sports.xml'),
('Sports', 'Times of India Sports', 'https://timesofindia.indiatimes.com/rssfeeds/4719148.cms'),
('Sports', 'The Indian Express Sports', 'https://indianexpress.com/section/sports/feed/'),
('Sports', 'Sportskeeda', 'https://www.sportskeeda.com/feed'),
('Sports', 'ESPN Top News', 'https://www.espn.com/espn/rss/news'),

-- ── Football ──────────────────────────────────────────────────────────
('Football', 'BBC Sport Football', 'https://feeds.bbci.co.uk/sport/football/rss.xml'),
('Football', 'CNN Football', 'http://rss.cnn.com/rss/edition_football.rss'),
('Football', 'The Hindu Football', 'https://www.thehindu.com/sport/football/feeder/default.rss'),
('Football', 'The Guardian Football', 'https://www.theguardian.com/football/rss'),
('Football', 'NYT Soccer', 'https://rss.nytimes.com/services/xml/rss/nyt/Soccer.xml'),
('Football', 'Soccer News', 'https://www.soccernews.com/feed'),

-- ── Tennis ────────────────────────────────────────────────────────────
('Tennis', 'BBC Sport Tennis', 'http://feeds.bbci.co.uk/sport/tennis/rss.xml'),
('Tennis', 'CNN Tennis', 'http://rss.cnn.com/rss/edition_tennis.rss'),
('Tennis', 'Essential Tennis Podcast', 'https://feed.podbean.com/essentialtennis/feed.xml'),
('Tennis', 'NYT Tennis', 'https://rss.nytimes.com/services/xml/rss/nyt/Tennis.xml'),
('Tennis', 'Perfect Tennis', 'https://www.perfect-tennis.com/feed/'),
('Tennis', 'The Hindu Tennis', 'https://www.thehindu.com/sport/tennis/feeder/default.rss'),
('Tennis', 'The Guardian Tennis', 'https://www.theguardian.com/sport/tennis/rss'),
('Tennis', 'ESPN Tennis', 'https://www.espn.com/espn/rss/tennis/news'),

-- ── Architecture ──────────────────────────────────────────────────────
('Architecture', 'ArchDaily Global', 'http://feeds.feedburner.com/Archdaily'),
('Architecture', 'Architectural Digest', 'https://www.architecturaldigest.com/feed/rss'),
('Architecture', 'Dezeen', 'https://www.dezeen.com/architecture/feed/'),
('Architecture', 'Design Milk Architecture', 'https://design-milk.com/category/architecture/feed/'),
('Architecture', 'Architizer Journal', 'https://architizer.wpengine.com/feed/'),
('Architecture', 'The Architects Newspaper', 'https://archpaper.com/feed'),
('Architecture', 'designboom Architecture', 'https://www.designboom.com/architecture/feed/'),
('Architecture', 'A Weekly Dose of Architecture Books', 'http://feeds.feedburner.com/archidose'),

-- ── Apple ─────────────────────────────────────────────────────────────
('Apple', '9to5Mac', 'https://9to5mac.com/feed'),
('Apple', 'Apple Newsroom', 'https://www.apple.com/newsroom/rss-feed.rss'),
('Apple', 'AppleInsider', 'https://appleinsider.com/rss/news/'),
('Apple', 'Cult of Mac', 'https://www.cultofmac.com/feed'),
('Apple', 'Daring Fireball', 'https://daringfireball.net/feeds/main'),
('Apple', 'MacRumors', 'http://feeds.macrumors.com/MacRumors-Mac'),
('Apple', 'MacStories', 'https://www.macstories.net/feed'),
('Apple', 'Macworld', 'https://www.macworld.com/index.rss'),
('Apple', 'OS X Daily', 'http://feeds.feedburner.com/osxdaily'),
('Apple', 'iMore', 'http://feeds.feedburner.com/TheiPhoneBlog'),

-- ── Movies ────────────────────────────────────────────────────────────
('Movies', '/Film', 'https://feeds2.feedburner.com/slashfilm'),
('Movies', 'Ain''t It Cool News', 'https://www.aintitcool.com/node/feed/'),
('Movies', 'ComingSoon.net', 'https://www.comingsoon.net/feed'),
('Movies', 'Deadline', 'https://deadline.com/feed/'),
('Movies', 'FirstShowing.net', 'https://www.firstshowing.net/feed/'),
('Movies', 'IndieWire', 'https://www.indiewire.com/feed'),
('Movies', 'Bleeding Cool Movies', 'https://www.bleedingcool.com/movies/feed/'),
('Movies', 'Variety', 'https://variety.com/feed/'),

-- ── Television ────────────────────────────────────────────────────────
('Television', 'Bleeding Cool TV', 'https://www.bleedingcool.com/tv/feed/'),
('Television', 'TV Fanatic', 'https://www.tvfanatic.com/rss.xml'),
('Television', 'TVLine', 'https://tvline.com/feed/'),
('Television', 'The TV Addict', 'http://feeds.feedburner.com/thetvaddict/AXob'),

-- ── Music ─────────────────────────────────────────────────────────────
('Music', 'Consequence', 'http://consequenceofsound.net/feed'),
('Music', 'Metal Injection', 'http://feeds.feedburner.com/metalinjection'),
('Music', 'Music Business Worldwide', 'https://www.musicbusinessworldwide.com/feed/'),
('Music', 'Pitchfork News', 'http://pitchfork.com/rss/news'),
('Music', 'Song Exploder', 'http://feed.songexploder.net/songexploder'),

-- ── History ───────────────────────────────────────────────────────────
('History', 'Dan Carlin''s Hardcore History', 'https://feeds.feedburner.com/dancarlin/history?format=xml'),
('History', 'History in 28-Minutes', 'https://www.historyisnowmagazine.com/blog?format=RSS'),
('History', 'HistoryNet', 'http://www.historynet.com/feed'),
('History', 'Throughline (NPR)', 'https://feeds.npr.org/510333/podcast.xml'),
('History', 'You Must Remember This', 'https://feeds.megaphone.fm/YMRT7068253588'),
('History', 'The Memory Palace', 'http://feeds.thememorypalace.us/thememorypalace'),

-- ── Programming ───────────────────────────────────────────────────────
('Programming', 'Overreacted (Dan Abramov)', 'https://overreacted.io/rss.xml'),
('Programming', 'Developer Tea', 'https://feeds.simplecast.com/dLRotFGk'),
('Programming', 'Twitter Engineering Blog', 'https://blog.twitter.com/engineering/en_us/blog.rss'),
('Programming', 'FLOSS Weekly', 'https://feeds.simplecast.com/gvtxUiIf'),
('Programming', 'InfoQ', 'https://feed.infoq.com'),

-- ── Web Development ───────────────────────────────────────────────────
('Web Development', 'A List Apart', 'https://alistapart.com/main/feed/'),
('Web Development', 'CSS-Tricks', 'https://css-tricks.com/feed/'),
('Web Development', 'Code Wall', 'https://www.codewall.co.uk/feed/'),
('Web Development', 'David Walsh Blog', 'https://davidwalsh.name/feed'),
('Web Development', 'Mozilla Hacks', 'https://hacks.mozilla.org/feed/'),
('Web Development', 'Google Web Updates', 'https://developers.google.com/web/updates/rss.xml'),

-- ══════════════════════════════════════════════════════════════════════
-- COUNTRY FEEDS (24 countries, mined via trackawesomelist.com mirror of
-- the same source repo — each country's official/major news outlets)
-- ══════════════════════════════════════════════════════════════════════

-- Australia
('Country: Australia', 'Daily Telegraph', 'https://www.dailytelegraph.com.au/news/breaking-news/rss'),
('Country: Australia', 'Sydney Morning Herald', 'https://www.smh.com.au/rss/feed.xml'),
('Country: Australia', 'Herald Sun', 'https://www.heraldsun.com.au/news/breaking-news/rss'),
('Country: Australia', 'ABC News', 'https://www.abc.net.au/news/feed/1948/rss.xml'),
('Country: Australia', 'The Age', 'https://www.theage.com.au/rss/feed.xml'),
('Country: Australia', 'The Courier Mail', 'https://www.couriermail.com.au/rss'),
('Country: Australia', 'PerthNow', 'https://www.perthnow.com.au/news/feed'),
('Country: Australia', 'Brisbane Times', 'https://www.brisbanetimes.com.au/rss/feed.xml'),
('Country: Australia', 'Crikey', 'https://feeds.feedburner.com/com/rCTl'),

-- Bangladesh
('Country: Bangladesh', 'The Daily Star', 'https://www.thedailystar.net/frontpage/rss.xml'),
('Country: Bangladesh', 'Bangla News 24', 'https://www.banglanews24.com/rss/rss.xml'),
('Country: Bangladesh', 'Prothom Alo', 'https://www.prothomalo.com/feed/'),

-- Brazil
('Country: Brazil', 'Folha de S.Paulo', 'https://feeds.folha.uol.com.br/emcimadahora/rss091.xml'),
('Country: Brazil', 'R7 Noticias', 'https://noticias.r7.com/feed.xml'),
('Country: Brazil', 'UOL', 'http://rss.home.uol.com.br/index.xml'),
('Country: Brazil', 'The Rio Times', 'https://riotimesonline.com/feed/'),

-- Canada
('Country: Canada', 'CBC Top Stories', 'https://www.cbc.ca/cmlink/rss-topstories'),
('Country: Canada', 'CTV News', 'https://www.ctvnews.ca/rss/ctvnews-ca-top-stories-public-rss-1.822009'),
('Country: Canada', 'Global News', 'https://globalnews.ca/feed/'),
('Country: Canada', 'National Post', 'https://nationalpost.com/feed/'),
('Country: Canada', 'Toronto Star', 'https://www.thestar.com/content/thestar/feed.RSSManagerServlet.articles.topstories.rss'),

-- Germany
('Country: Germany', 'ZEIT ONLINE', 'http://newsfeed.zeit.de/index'),
('Country: Germany', 'FOCUS Online', 'https://rss.focus.de/fol/XML/rss_folnews.xml'),
('Country: Germany', 'FAZ.NET', 'https://www.faz.net/rss/aktuell/'),
('Country: Germany', 'Tagesschau', 'http://www.tagesschau.de/xml/rss2'),
('Country: Germany', 'Deutsche Welle', 'https://rss.dw.com/rdf/rss-en-all'),

-- Spain
('Country: Spain', 'EL PAIS', 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada'),
('Country: Spain', 'El Confidencial', 'https://rss.elconfidencial.com/espana/'),
('Country: Spain', 'ElDiario.es', 'https://www.eldiario.es/rss/'),
('Country: Spain', 'Euro Weekly News', 'https://www.euroweeklynews.com/feed/'),

-- France
('Country: France', 'France24', 'https://www.france24.com/en/rss'),
('Country: France', 'Le Monde', 'https://www.lemonde.fr/rss/une.xml'),
('Country: France', 'L''Obs', 'https://www.nouvelobs.com/a-la-une/rss.xml'),
('Country: France', 'Franceinfo', 'https://www.francetvinfo.fr/titres.rss'),
('Country: France', 'Ouest-France', 'https://www.ouest-france.fr/rss-en-continu.xml'),

-- Hong Kong
('Country: Hong Kong', 'Hong Kong Free Press', 'https://www.hongkongfp.com/feed/'),
('Country: Hong Kong', 'South China Morning Post', 'https://www.scmp.com/rss/91/feed'),

-- Indonesia
('Country: Indonesia', 'Republika Online', 'https://www.republika.co.id/rss/'),
('Country: Indonesia', 'Tribunnews.com', 'https://www.tribunnews.com/rss'),
('Country: Indonesia', 'Merdeka.com', 'https://www.merdeka.com/feed/'),
('Country: Indonesia', 'Suara.com', 'https://www.suara.com/rss'),

-- Ireland
('Country: Ireland', 'TheJournal.ie', 'https://www.thejournal.ie/feed/'),
('Country: Ireland', 'BreakingNews.ie', 'https://feeds.breakingnews.ie/bntopstories'),
('Country: Ireland', 'Irish Examiner', 'https://feeds.feedburner.com/ietopstories'),
('Country: Ireland', 'IrishCentral', 'https://feeds.feedburner.com/IrishCentral'),

-- Iran
('Country: Iran', 'ISNA News Agency', 'https://www.isna.ir/rss'),
('Country: Iran', 'Mehr News Agency', 'https://www.mehrnews.com/rss'),

-- Italy
('Country: Italy', 'ANSA.it', 'https://www.ansa.it/sito/ansait_rss.xml'),
('Country: Italy', 'Fanpage', 'https://www.fanpage.it/feed/'),
('Country: Italy', 'Repubblica.it', 'https://www.repubblica.it/rss/homepage/rss2.0.xml'),
('Country: Italy', 'Il Post', 'https://www.ilpost.it/feed/'),

-- Japan
('Country: Japan', 'Japan Times', 'https://www.japantimes.co.jp/feed/topstories/'),
('Country: Japan', 'Japan Today', 'https://japantoday.com/feed'),
('Country: Japan', 'Kyodo News', 'https://english.kyodonews.net/rss/all.xml'),
('Country: Japan', 'NYT Japan', 'https://www.nytimes.com/svc/collections/v1/publish/http://www.nytimes.com/topic/destination/japan/rss.xml'),

-- Mexico
('Country: Mexico', 'Excelsior', 'https://www.excelsior.com.mx/rss.xml'),
('Country: Mexico', 'Reforma', 'https://www.reforma.com/rss/portada.xml'),
('Country: Mexico', 'Mexico News Daily', 'https://mexiconewsdaily.com/feed/'),

-- Myanmar
('Country: Myanmar', 'Myanmar Gazette', 'http://myanmargazette.net/feed'),
('Country: Myanmar', 'DVB Multimedia Group', 'http://www.dvb.no/feed'),

-- Nigeria
('Country: Nigeria', 'SaharaReporters', 'http://saharareporters.com/feeds/latest/feed'),
('Country: Nigeria', 'Legit.ng', 'https://www.legit.ng/rss/all.rss'),
('Country: Nigeria', 'Premium Times Nigeria', 'https://www.premiumtimesng.com/feed'),
('Country: Nigeria', 'The Guardian Nigeria', 'https://guardian.ng/feed/'),

-- Philippines
('Country: Philippines', 'INQUIRER.net', 'https://www.inquirer.net/fullfeed'),
('Country: Philippines', 'philstar.com', 'https://www.philstar.com/rss/headlines'),
('Country: Philippines', 'GMA News Online', 'https://data.gmanews.tv/gno/rss/news/feed.xml'),
('Country: Philippines', 'Philippine News Agency', 'https://www.pna.gov.ph/latest.rss'),

-- Pakistan
('Country: Pakistan', 'The Express Tribune', 'https://tribune.com.pk/feed/home'),
('Country: Pakistan', 'The News International', 'https://www.thenews.com.pk/rss/1/1'),

-- Poland
('Country: Poland', 'Newsweek Polska', 'https://www.newsweek.pl/rss.xml'),
('Country: Poland', 'Polska Agencja Prasowa', 'https://www.pap.pl/rss.xml'),

-- Russia
('Country: Russia', 'Meduza.io', 'https://meduza.io/rss/all'),
('Country: Russia', 'The Moscow Times', 'https://www.themoscowtimes.com/rss/news'),
('Country: Russia', 'TASS', 'http://tass.com/rss/v2.xml'),

-- Ukraine
('Country: Ukraine', 'UNIAN (English)', 'https://rss.unian.net/site/news_eng.rss'),
('Country: Ukraine', 'Ukrainska Pravda', 'https://www.pravda.com.ua/rss/'),
('Country: Ukraine', 'NV', 'https://nv.ua/rss/all.xml'),

-- United States
('Country: United States', 'HuffPost World News', 'https://www.huffpost.com/section/world-news/feed'),
('Country: United States', 'NYT Top Stories', 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml'),
('Country: United States', 'FOX News', 'http://feeds.foxnews.com/foxnews/latest'),
('Country: United States', 'WSJ World News', 'https://feeds.a.dj.com/rss/RSSWorldNews.xml'),
('Country: United States', 'LA Times World & Nation', 'https://www.latimes.com/world-nation/rss2.0.xml'),
('Country: United States', 'Politico Playbook', 'https://rss.politico.com/playbook.xml'),

-- South Africa
('Country: South Africa', 'SowetanLIVE', 'https://www.sowetanlive.co.za/rss/?publication=sowetan-live'),
('Country: South Africa', 'BusinessTech', 'https://businesstech.co.za/news/feed/'),
('Country: South Africa', 'News24 Top Stories', 'http://feeds.news24.com/articles/news24/TopStories/rss'),
('Country: South Africa', 'Daily Maverick', 'https://www.dailymaverick.co.za/dmrss/'),
('Country: South Africa', 'Moneyweb', 'https://www.moneyweb.co.za/feed/'),
('Country: South Africa', 'TimesLIVE', 'https://www.timeslive.co.za/rss/'),

-- Additional India feeds beyond what's already in News India's active niche
('Country: India (additional)', 'DNA India', 'https://www.dnaindia.com/feeds/india.xml'),
('Country: India (additional)', 'Outlook India', 'https://www.outlookindia.com/rss/main/magazine'),
('Country: India (additional)', 'Moneycontrol', 'http://www.moneycontrol.com/rss/latestnews.xml'),
('Country: India (additional)', 'Financial Express', 'https://www.financialexpress.com/feed/'),
('Country: India (additional)', 'The Hindu Business Line', 'https://www.thehindubusinessline.com/feeder/default.rss'),
('Country: India (additional)', 'OpIndia', 'https://feeds.feedburner.com/opindia'),
('Country: India (additional)', 'Swarajya', 'https://prod-qt-images.s3.amazonaws.com/production/swarajya/feed.xml'),
('Country: India (additional)', 'Amar Ujala (Hindi)', 'https://www.amarujala.com/rss/breaking-news.xml'),
('Country: India (additional)', 'Navbharat Times (Hindi)', 'https://navbharattimes.indiatimes.com/rssfeedsdefault.cms'),
('Country: India (additional)', 'Live Hindustan (Hindi)', 'https://feed.livehindustan.com/rss/3127'),
('Country: India (additional)', 'Dainik Bhaskar (Hindi)', 'https://www.bhaskar.com/rss-feed/1061/'),

-- ══════════════════════════════════════════════════════════════════════
-- MORE RECOMMENDED CATEGORIES (mined via trackawesomelist mirror)
-- ══════════════════════════════════════════════════════════════════════

-- Android
('Android', 'Android (Google Blog)', 'https://blog.google/products/android/rss'),
('Android', 'Android Authority', 'https://www.androidauthority.com/feed'),
('Android', 'Android Central', 'http://feeds.androidcentral.com/androidcentral'),
('Android', 'Android Police', 'http://feeds.feedburner.com/AndroidPolice'),
('Android', 'Droid Life', 'https://www.droid-life.com/feed'),
('Android', 'GSMArena', 'https://www.gsmarena.com/rss-news-reviews.php3'),
('Android', 'xda-developers', 'https://data.xda-developers.com/portal-feed'),

-- Android Development
('Android Development', 'Android Developers Blog', 'http://feeds.feedburner.com/blogspot/hsDu'),
('Android Development', 'Jake Wharton', 'https://jakewharton.com/atom.xml'),
('Android Development', 'ProAndroidDev', 'https://proandroiddev.com/feed'),
('Android Development', 'Kt. Academy', 'https://blog.kotlin-academy.com/feed'),

-- Beauty
('Beauty', 'ELLE Beauty', 'https://www.elle.com/rss/beauty.xml/'),
('Beauty', 'Fashionista Beauty', 'https://fashionista.com/.rss/excerpt/beauty'),
('Beauty', 'Into The Gloss', 'https://feeds.feedburner.com/intothegloss/oqoU'),
('Beauty', 'POPSUGAR Beauty', 'https://www.popsugar.com/beauty/feed'),
('Beauty', 'Refinery29 Beauty', 'https://www.refinery29.com/beauty/rss.xml'),

-- Books
('Books', 'Book Riot', 'https://bookriot.com/feed/'),
('Books', 'Kirkus Reviews', 'https://www.kirkusreviews.com/feeds/rss/'),
('Books', 'A Year of Reading the World', 'https://ayearofreadingtheworld.com/feed/'),

-- Cars
('Cars', 'Autoblog', 'https://www.autoblog.com/rss.xml'),
('Cars', 'Autocar (UK)', 'https://www.autocar.co.uk/rss'),
('Cars', 'BMW BLOG', 'https://feeds.feedburner.com/BmwBlog'),
('Cars', 'Carscoops', 'https://www.carscoops.com/feed/'),
('Cars', 'Jalopnik', 'https://jalopnik.com/rss'),
('Cars', 'Car and Driver', 'https://www.caranddriver.com/rss/all.xml/'),
('Cars', 'Bring a Trailer', 'https://bringatrailer.com/feed/'),

-- Interior Design
('Interior design', 'Apartment Therapy Design', 'https://www.apartmenttherapy.com/design.rss'),
('Interior design', 'Core77', 'http://feeds.feedburner.com/core77/blog'),
('Interior design', 'Ideal Home', 'https://www.idealhome.co.uk/feed'),
('Interior design', 'Dezeen Interiors', 'https://www.dezeen.com/interiors/feed/'),
('Interior design', 'Yanko Design', 'http://feeds.feedburner.com/yankodesign'),
('Interior design', 'Young House Love', 'https://www.younghouselove.com/feed/'),

-- DIY
('DIY', 'A Beautiful Mess', 'https://abeautifulmess.com/feed'),
('DIY', 'Hackaday', 'https://hackaday.com/blog/feed/'),
('DIY', 'How-To Geek', 'https://www.howtogeek.com/feed/'),
('DIY', 'IKEA Hackers', 'https://www.ikeahackers.net/feed'),
('DIY', 'WonderHowTo', 'https://www.wonderhowto.com/rss.xml')

on conflict (feed_url) do nothing;

-- ── Sanity check ──────────────────────────────────────────────────────
-- select category, count(*) from feed_library group by category order by category;


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_social_quality.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Social-feed and production-quality upgrade.

-- Public and operator-authorised RSS/Atom feeds for social platforms.
-- Example YouTube native Atom feed:
-- [{"platform":"youtube","label":"Creator name","url":"https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID"}]
-- Twitch, X/Twitter, and Kick have no dependable native public channel RSS
-- endpoint. Add only an RSS export you are authorised to use, e.g.
-- [{"platform":"twitch","label":"My streamer feed","url":"https://...","auth_key":"creator_feed"}]
alter table niche_configurations
  add column if not exists social_rss_feeds jsonb not null default '[]'::jsonb;

-- Rich metadata lets Agent 3 select a soundtrack by story mood, genre and
-- tempo instead of choosing a random track from an energy bucket.
alter table music_library
  add column if not exists mood_tags text[] not null default '{}',
  add column if not exists bpm integer,
  add column if not exists instrumental boolean not null default true;

-- Example inventory record (replace with a public URL to music you licensed):
-- insert into music_library (track_url, title, genre, energy_level, mood_tags, bpm, instrumental, license_note)
-- values ('https://YOUR_PROJECT.supabase.co/storage/v1/object/public/music/tense-pulse.mp3',
--         'Tense Pulse', 'ambient electronic', 'Suspense', array['tense','focused','dark'], 92, true,
--         'Licensed from: <source>; license: <terms>');

comment on column niche_configurations.social_rss_feeds is
  'Public or operator-authorised social RSS/Atom sources; never use for access-control bypassing.';


-- ═══════════════════════════════════════════════════════════════════════
-- SOURCE: migration_clip_jobs.sql
-- ═══════════════════════════════════════════════════════════════════════
-- Long-form clipper (Agent 6): turns a long-form video YOU HAVE RIGHTS TO
-- (a manual upload, or a direct file URL to CC-licensed/public-domain
-- footage) into a set of short vertical clips, using the same hook/pacing
-- rubric as Agent 2's scriptwriting and the same Shotstack render pipeline
-- as Agent 4. This is deliberately NOT a YouTube-URL scraper — source_type
-- is constrained to 'upload' or 'cc_licensed' at the application layer, and
-- a license_note is required for 'cc_licensed' so provenance is always on
-- record.
create table if not exists clip_jobs (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('upload','cc_licensed')),
  source_url text not null,           -- public URL of the uploaded file or the CC-licensed direct file URL
  source_label text,                  -- optional title / creator credit
  license_note text,                  -- required for source_type='cc_licensed' (enforced in routes/clips.js)
  niche text,                         -- optional: borrows that niche's caption style preset
  status text not null default 'Transcribing',
  transcript jsonb,                   -- word-level timestamps from Whisper
  clip_plan jsonb,                    -- [{start,end,title,hook_score,reason}, ...]
  rendered_clips jsonb not null default '[]'::jsonb, -- [{start,end,title,url,shotstack_render_id}, ...]
  error text,
  openai_tokens integer not null default 0,
  shotstack_render_seconds numeric not null default 0,
  created_at timestamptz not null default now()
);

alter table clip_jobs enable row level security;

-- Storage: create a public "uploads" bucket in the Supabase dashboard
-- (Storage → New bucket → name "uploads" → Public) for source video files,
-- alongside the existing "renders" bucket Agent 3/4 already use.

