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
