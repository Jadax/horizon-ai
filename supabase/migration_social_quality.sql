-- HORIZON AI — social-feed and production-quality upgrade
-- Run this once in the Supabase SQL editor after COMPLETE_SETUP.sql.

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
