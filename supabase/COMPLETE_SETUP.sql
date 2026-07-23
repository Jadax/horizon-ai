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

CREATE TABLE IF NOT EXISTS clip_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('upload', 'cc_licensed', 'vimeo_own')),
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
