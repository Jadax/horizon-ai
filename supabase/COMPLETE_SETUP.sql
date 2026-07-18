-- ═══════════════════════════════════════════════════════════════════════
-- MONETIZATION SECTION — appended to COMPLETE_SETUP.sql
-- ═══════════════════════════════════════════════════════════════════════

-- 1. Add monetization columns to pipeline_logs
ALTER TABLE pipeline_logs 
ADD COLUMN IF NOT EXISTS viral_score numeric,
ADD COLUMN IF NOT EXISTS viral_score_breakdown jsonb,
ADD COLUMN IF NOT EXISTS source_platform text,
ADD COLUMN IF NOT EXISTS source_download_url text,
ADD COLUMN IF NOT EXISTS original_views integer,
ADD COLUMN IF NOT EXISTS original_likes integer,
ADD COLUMN IF NOT EXISTS original_comments integer,
ADD COLUMN IF NOT EXISTS affiliate_products jsonb,
ADD COLUMN IF NOT EXISTS affiliate_revenue numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS published_to jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS content_quality_score numeric;

-- 2. Create monetization tracking table
CREATE TABLE IF NOT EXISTS monetization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_log_id uuid REFERENCES pipeline_logs(id) ON DELETE CASCADE,
  platform text NOT NULL,
  revenue numeric DEFAULT 0,
  views integer DEFAULT 0,
  clicks integer DEFAULT 0,
  conversions integer DEFAULT 0,
  recorded_at timestamptz DEFAULT now()
);

ALTER TABLE monetization ENABLE ROW LEVEL SECURITY;

-- 3. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_viral_score 
ON pipeline_logs (viral_score DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_logs_affiliate_revenue 
ON pipeline_logs (affiliate_revenue DESC);

CREATE INDEX IF NOT EXISTS idx_monetization_pipeline_log_id 
ON monetization (pipeline_log_id);

CREATE INDEX IF NOT EXISTS idx_monetization_recorded_at 
ON monetization (recorded_at DESC);

-- 4. Add high-RPM niches (Finance, Technology) - active = FALSE by default
INSERT INTO niche_configurations
  (niche_name, target_sources, footage_keywords, rss_feeds, mastodon_tags, lemmy_communities,
   voice_profile_id, trend_region, language, target_duration_min_seconds, target_duration_max_seconds,
   active, editing_style_preset)
VALUES
(
  'Finance',
  '{}',
  array[
    'stock market screen', 'money counting', 'financial charts', 'bank building',
    'crypto trading', 'piggy bank', 'dollar bills', 'credit card payment'
  ],
  array[
    'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    'https://finance.yahoo.com/news/rssindex',
    'https://www.wsj.com/feed/rss',
    'https://www.forbes.com/finance/feed/',
    'https://feeds.feedburner.com/fool-watch'
  ],
  array['finance', 'investing', 'crypto'],
  array['finance', 'cryptocurrency'],
  'onwK4e9ZLuTAKqWW03F9',
  'US',
  'en',
  30,
  60,
  false,
  '{
    "caption": {"color":"#10B981","font":"Montserrat ExtraBold","position":"bottom","style":"heavy-sans"},
    "transitions":"fast-cut",
    "music_energy":"High",
    "music_db":-16,
    "zoom":"kenburns-fast",
    "wordClipMode": false
  }'::jsonb
),
(
  'Technology',
  '{}',
  array[
    'tech startup office', 'ai robot', 'smartphone closeup', 'data center server',
    'coding laptop', 'future tech lab', 'digital interface', 'drone technology'
  ],
  array[
    'https://techcrunch.com/feed/',
    'https://www.theverge.com/rss/index.xml',
    'https://www.wired.com/feed/rss',
    'https://arstechnica.com/feed/',
    'https://feeds.feedburner.com/TechCrunch/Startups'
  ],
  array['technology', 'ai', 'gadgets'],
  array['technology', 'gadgets'],
  'onwK4e9ZLuTAKqWW03F9',
  'US',
  'en',
  30,
  60,
  false,
  '{
    "caption": {"color":"#38BDF8","font":"Montserrat ExtraBold","position":"bottom","style":"heavy-sans"},
    "transitions":"fast-cut",
    "music_energy":"High",
    "music_db":-16,
    "zoom":"kenburns-fast",
    "wordClipMode": false
  }'::jsonb
)
ON CONFLICT (niche_name) DO UPDATE SET
  rss_feeds = excluded.rss_feeds,
  footage_keywords = excluded.footage_keywords,
  target_duration_min_seconds = excluded.target_duration_min_seconds,
  target_duration_max_seconds = excluded.target_duration_max_seconds,
  active = excluded.active;

-- 5. View for monetization dashboard
CREATE OR REPLACE VIEW monetization_dashboard AS
SELECT 
  p.niche,
  COUNT(DISTINCT p.id) as total_videos,
  SUM(p.affiliate_revenue) as total_affiliate_revenue,
  SUM(m.revenue) as total_platform_revenue,
  SUM(m.views) as total_views,
  SUM(m.clicks) as total_clicks,
  SUM(m.conversions) as total_conversions,
  AVG(p.viral_score) as avg_viral_score
FROM pipeline_logs p
LEFT JOIN monetization m ON p.id = m.pipeline_log_id
GROUP BY p.niche;

-- 6. Grant permissions
GRANT SELECT ON monetization_dashboard TO authenticated;