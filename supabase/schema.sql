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
