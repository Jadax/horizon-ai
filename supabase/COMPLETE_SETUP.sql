CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS pipeline_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  niche text NOT NULL,
  status text NOT NULL DEFAULT 'Queued',
  error text,
  topic text,
  source_url text,
  source_platform text,
  source_download_url text,
  sourced_media_urls jsonb DEFAULT '[]'::jsonb,
  script text,
  title text,
  title_reasoning text,
  title_pattern text,
  description text,
  tags jsonb DEFAULT '[]'::jsonb,
  format_decision jsonb,
  calculated_trim_points jsonb,
  voiceover_url text,
  voiceover_words jsonb,
  duration_seconds numeric,
  subtitle_sync_precision_ms integer,
  subtitles_url text,
  music_track_id uuid,
  music_track_url text,
  preset_snapshot jsonb,
  rendered_video_url text,
  thumbnail_url text,
  cover_variants jsonb DEFAULT '[]'::jsonb,
  shotstack_render_id text,
  content_quality_score numeric,
  quality_report jsonb,
  publish_package jsonb,
  target_channel text DEFAULT 'primary',
  target_region text,
  publish_schedule timestamptz,
  published_to jsonb DEFAULT '[]'::jsonb,
  youtube_video_id text,
  original_views bigint,
  original_likes bigint,
  original_comments bigint,
  viral_score numeric,
  viral_score_breakdown jsonb,
  yt_views bigint,
  yt_likes bigint,
  yt_comments bigint,
  yt_ctr numeric,
  yt_avg_view_percentage numeric,
  stats_updated_at timestamptz,
  affiliate_products jsonb DEFAULT '[]'::jsonb,
  affiliate_revenue numeric DEFAULT 0,
  estimated_platform_revenue numeric DEFAULT 0,
  openai_tokens bigint DEFAULT 0,
  elevenlabs_characters bigint DEFAULT 0,
  shotstack_render_seconds numeric DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_quality_range CHECK (content_quality_score IS NULL OR content_quality_score BETWEEN 0 AND 100),
  CONSTRAINT pipeline_sync_precision CHECK (subtitle_sync_precision_ms IS NULL OR subtitle_sync_precision_ms BETWEEN 0 AND 50)
);

ALTER TABLE pipeline_logs ADD COLUMN IF NOT EXISTS quality_report jsonb;
ALTER TABLE pipeline_logs ADD COLUMN IF NOT EXISTS publish_package jsonb;
ALTER TABLE pipeline_logs ADD COLUMN IF NOT EXISTS subtitle_sync_precision_ms integer;
ALTER TABLE pipeline_logs ADD COLUMN IF NOT EXISTS subtitles_url text;
ALTER TABLE pipeline_logs ADD COLUMN IF NOT EXISTS thumbnail_url text;
ALTER TABLE pipeline_logs ADD COLUMN IF NOT EXISTS cover_variants jsonb DEFAULT '[]'::jsonb;
ALTER TABLE pipeline_logs ADD COLUMN IF NOT EXISTS yt_ctr numeric;
ALTER TABLE pipeline_logs ADD COLUMN IF NOT EXISTS yt_avg_view_percentage numeric;
ALTER TABLE pipeline_logs ADD COLUMN IF NOT EXISTS estimated_platform_revenue numeric DEFAULT 0;

CREATE TABLE IF NOT EXISTS niche_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  niche_name text UNIQUE NOT NULL,
  target_sources text[] DEFAULT '{}',
  footage_keywords text[] DEFAULT '{}',
  rss_feeds text[] DEFAULT '{}',
  mastodon_tags text[] DEFAULT '{}',
  lemmy_communities text[] DEFAULT '{}',
  lore_wiki_apis text[] DEFAULT '{}',
  social_rss_feeds text[] DEFAULT '{}',
  voice_profile_id text,
  target_channel text DEFAULT 'primary',
  trend_region text DEFAULT 'US',
  language text DEFAULT 'en',
  target_duration_min_seconds integer DEFAULT 30,
  target_duration_max_seconds integer DEFAULT 60,
  active boolean DEFAULT false,
  editing_style_preset jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
-- Keep this in sync with the CREATE above for databases created before the
-- social_rss_feeds column existed (the dashboard PATCHes it via niches.js).
ALTER TABLE niche_configurations ADD COLUMN IF NOT EXISTS social_rss_feeds text[] DEFAULT '{}';

CREATE TABLE IF NOT EXISTS music_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  track_url text NOT NULL,
  energy_level text NOT NULL,
  mood_tags text[] DEFAULT '{}',
  genre text,
  bpm integer,
  instrumental boolean DEFAULT true,
  license text,
  created_at timestamptz DEFAULT now()
);
-- Neither music:sync nor music:brain requires this (both dedupe via a
-- select-then-insert/update instead of ON CONFLICT, verified against a
-- table with no unique constraint), but it's cheap, safe to re-run, and
-- lets you dedupe by hand from the SQL editor if you ever want to.
CREATE UNIQUE INDEX IF NOT EXISTS music_library_title_energy_key ON music_library (title, energy_level);

CREATE TABLE IF NOT EXISTS sfx_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  track_url text NOT NULL,
  tags text[] DEFAULT '{}',
  license text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text UNIQUE NOT NULL,
  category text,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trend_rules (
  rule_key text PRIMARY KEY,
  weight numeric NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Trend velocity history: per-run snapshots of how many candidates matched
-- each topic_key (cross-source corroboration count) + a proxy score, stored
-- over time so the scorer can compute RGR/velocity/acceleration (stolen from
-- the Google Trends "Rising vs Breakout" model). A topic whose corroboration
-- count is CLIMBING across runs is pre-peak and worth a score boost; a
-- flat/decaying topic is post-peak and gets docked. The formula only kicks in
-- once >=3 snapshots exist, so it stays neutral on day one instead of
-- over-fitting noise.
CREATE TABLE IF NOT EXISTS trend_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_key text NOT NULL,
  source text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  count numeric NOT NULL DEFAULT 1,
  proxy_score numeric DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trend_history_key_time ON trend_history (topic_key, observed_at);
ALTER TABLE trend_history ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS clip_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('upload', 'cc_licensed', 'vimeo_own', 'ytdlp_own')),
  source_url text NOT NULL,
  source_label text,
  license_note text,
  niche text,
  status text NOT NULL DEFAULT 'Queued',
  transcript jsonb,
  clip_plan jsonb DEFAULT '[]'::jsonb,
  rendered_clips jsonb DEFAULT '[]'::jsonb,
  error text,
  openai_tokens bigint DEFAULT 0,
  shotstack_render_seconds numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
-- Migrate databases created before ytdlp_own joined the allowed source types
-- (routes/clips.js POST /api/clips/from-url inserts it for YouTube/Twitch/
-- Kick/Reddit/etc. URLs; the old CHECK would reject the insert with a
-- constraint violation and kill the whole clip job).
ALTER TABLE clip_jobs DROP CONSTRAINT IF EXISTS clip_jobs_source_type_check;
ALTER TABLE clip_jobs ADD CONSTRAINT clip_jobs_source_type_check CHECK (source_type IN ('upload', 'cc_licensed', 'vimeo_own', 'ytdlp_own'));

-- Stock-footage search cache (steal from MoneyPrinterTurbo's persistent
-- material caching): Pexels/Pixabay searches for the same keyword return the
-- same result set for weeks, so agent1 re-fetching them on every job burns
-- API quota and adds seconds of latency for zero new information. Cached for
-- TTL days, then re-fetched. payload jsonb holds the normalized clip list.
CREATE TABLE IF NOT EXISTS material_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key text UNIQUE NOT NULL,
  provider text NOT NULL,
  keyword text NOT NULL,
  payload jsonb DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE material_cache ENABLE ROW LEVEL SECURITY;

-- Auto-engagement log (Agent 7): every comment read + reply posted per
-- published video, so the weekly engagement pass never double-replies and
-- the dashboard can audit what the channel said.
CREATE TABLE IF NOT EXISTS engagement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_log_id uuid,
  youtube_video_id text,
  comment_id text UNIQUE NOT NULL,
  comment_author text,
  comment_text text,
  comment_like_count bigint DEFAULT 0,
  channel_key text,
  niche text,
  classification text,
  status text NOT NULL DEFAULT 'read',
  reply_text text,
  reply_id text,
  replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_engagement_video ON engagement (youtube_video_id);
CREATE INDEX IF NOT EXISTS idx_engagement_replied ON engagement (status, replied_at);
ALTER TABLE engagement ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS publish_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_log_id uuid NOT NULL REFERENCES pipeline_logs(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('youtube', 'tiktok', 'instagram', 'linkedin')),
  mode text NOT NULL CHECK (mode IN ('direct', 'package')),
  status text NOT NULL DEFAULT 'package_ready',
  package jsonb NOT NULL,
  external_id text,
  external_url text,
  scheduled_at timestamptz,
  published_at timestamptz,
  error text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (pipeline_log_id, platform)
);

CREATE TABLE IF NOT EXISTS learning_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_log_id uuid UNIQUE NOT NULL REFERENCES pipeline_logs(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  cohort_key text NOT NULL,
  metric_value numeric NOT NULL,
  cohort_median numeric NOT NULL,
  success boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS bayesian_posteriors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension text NOT NULL,
  arm_key text NOT NULL,
  platform text NOT NULL,
  niche text NOT NULL,
  alpha numeric NOT NULL DEFAULT 1,
  beta numeric NOT NULL DEFAULT 1,
  samples integer NOT NULL DEFAULT 0,
  posterior_mean numeric NOT NULL DEFAULT 0.5,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (dimension, arm_key, platform, niche)
);

CREATE TABLE IF NOT EXISTS learning_runs (
  week_start date PRIMARY KEY,
  status text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  report jsonb,
  error text
);

CREATE TABLE IF NOT EXISTS monetization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_log_id uuid REFERENCES pipeline_logs(id) ON DELETE CASCADE,
  platform text NOT NULL,
  estimated_revenue numeric DEFAULT 0,
  actual_revenue numeric,
  views bigint DEFAULT 0,
  clicks bigint DEFAULT 0,
  conversions bigint DEFAULT 0,
  recorded_at timestamptz DEFAULT now()
);

ALTER TABLE monetization ADD COLUMN IF NOT EXISTS estimated_revenue numeric DEFAULT 0;
ALTER TABLE monetization ADD COLUMN IF NOT EXISTS actual_revenue numeric;

-- Revenue estimates are refreshed repeatedly as view counts change. Retain the
-- newest estimate per published video and platform before enforcing that rule.
DELETE FROM monetization
WHERE id IN (
  SELECT id
  FROM (
    SELECT id, row_number() OVER (
      PARTITION BY pipeline_log_id, platform
      ORDER BY recorded_at DESC, id DESC
    ) AS duplicate_rank
    FROM monetization
  ) duplicates
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_monetization_pipeline_platform
  ON monetization (pipeline_log_id, platform);

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_created ON pipeline_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_quality ON pipeline_logs (content_quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_clip_jobs_created ON clip_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publish_targets_status ON publish_targets (platform, status);
CREATE INDEX IF NOT EXISTS idx_learning_outcomes_observed ON learning_outcomes (observed_at DESC);

INSERT INTO storage.buckets (id, name, public)
VALUES ('renders', 'renders', true), ('uploads', 'uploads', true)
ON CONFLICT (id) DO UPDATE SET public = excluded.public;

DROP POLICY IF EXISTS "public read renders" ON storage.objects;
DROP POLICY IF EXISTS "public read uploads" ON storage.objects;
CREATE POLICY "public read renders" ON storage.objects FOR SELECT USING (bucket_id = 'renders');
CREATE POLICY "public read uploads" ON storage.objects FOR SELECT USING (bucket_id = 'uploads');

ALTER TABLE pipeline_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE niche_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clip_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bayesian_posteriors ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE monetization ENABLE ROW LEVEL SECURITY;

-- ── Leo video library ──
-- Tracks every source video Leo has analyzed, all clippable moments found
-- in it, and which ones have already been used. The pipeline picks the
-- best unused clip, renders it, marks it used, and enforces a minimum
-- gap (COOLDOWN_DAYS) before posting from the same source video again.
-- ── Linked channels ──
-- Per-channel credentials for YouTube/Instagram/TikTok, linked from the
-- dashboard's Channel Manager. Replaces the old env-var-only setup
-- (GOOGLE_CHANNELS/INSTAGRAM_CHANNELS/TIKTOK_CHANNELS) so a new account can
-- be connected without a redeploy — required on Cloud Run, whose container
-- filesystem doesn't persist across restarts. channel_key is the stable
-- slug niches route uploads to (e.g. "leo", "primary"); credentials holds
-- refresh_token (YouTube) or access_token/business_id (Instagram/TikTok).
CREATE TABLE IF NOT EXISTS linked_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('youtube','instagram','tiktok')),
  channel_key text NOT NULL,
  label text NOT NULL,
  handle text,
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (platform, channel_key)
);
CREATE INDEX IF NOT EXISTS idx_linked_channels_platform ON linked_channels (platform);
ALTER TABLE linked_channels ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS leo_video_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file text UNIQUE NOT NULL,
  source_filename text NOT NULL,
  duration_seconds numeric NOT NULL,
  file_size_bytes bigint,
  -- Full analysis: array of clippable moments found by vision AI
  -- Each entry: { start, end, duration, score, description, mood, hook_idea }
  clips_analysis jsonb DEFAULT '[]'::jsonb,
  -- Which clip indices (0-based into clips_analysis) have been used
  used_clip_indices integer[] DEFAULT '{}',
  -- When this video was last posted from (to enforce cooldown)
  last_posted_at timestamptz,
  -- Number of shorts created from this video so far
  shorts_made integer DEFAULT 0,
  -- Total clippable moments found
  total_clips integer DEFAULT 0,
  -- Overall quality score of the video (averaged from clip scores)
  overall_score numeric,
  -- Analysis metadata (Gemini model used, frame count sampled, etc.)
  analysis_meta jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE leo_video_library ENABLE ROW LEVEL SECURITY;
