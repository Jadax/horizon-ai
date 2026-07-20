## Active Rules
- Keep scripts modular; do not duplicate helper functions — reuse existing lib/pipeline code.
- Never write extensive explanatory text in responses; output code/diffs directly, keep prose to 1-3 lines.
- Supabase: one file only — `supabase/COMPLETE_SETUP.sql`. Never create separate migration files.
- Every commit: bump `package.json` version (semver), write a short commit summary, then `git push` automatically (`GIT_TERMINAL_PROMPT=0 git push origin master`) — no confirmation needed.
- No new paid API/service dependencies without asking first.
- No YouTube/Twitch/Kick scraping or downloading — no official download API exists for any of them, even to the owner. Vimeo/CC-licensed/manual upload only.

## Architecture (single Node service, in-process everything)
Pipeline per job (`src/pipeline/run.js` → `runPipelineForNiche`):
1. `agent1_harvester.js` — topics from `src/sources/*` (RSS, Google Trends, Reddit public JSON, Mastodon/Lemmy, HN Algolia, Wikimedia pageviews, Bluesky What's Hot, GDELT); ranked by `lib/trendScoring.js`; returns top + alternates (orchestrator falls back to next topic if the quality gate rejects all drafts).
2. `formatDecision.js` — word-clip vs narrated, duration, mood.
3. `agent2_scriptwriter.js` — gpt-4o script + revisions; gate = `lib/contentQuality.js` (calibrated critic: filler ~38, strong ~79-84; threshold default 78; `blocking_issues` hard-fail at any score). Targeted revisions name weakest dimensions.
4. `agent1.harvestFootage` — Pexels/Pixabay + gpt-4o-mini vision QA; zero-match beats get gpt-image-1 AI cutaways (capped 4; refuses real people — handled gracefully).
5. `agent3_audio.js` — TTS (`lib/freeTTS.js`, default engine `openai` = gpt-4o-mini-tts, fallback gtts) → whisper-1 word alignment. gpt-4o-mini-tts intermittently truncates: "audio incomplete" triggers re-synthesis (3x). Sparse whisper word timestamps rebuilt from segments.
6. `agent4_shotstack.js` + `lib/freeVideoRender.js` — in-process ffmpeg (ffmpeg-static): concat legs, ken-burns zoompan on `type:"image"` clips, ONE `ass=` subtitle filter (NEVER chained drawtext — breaks at 80+ captions), music via sidechaincompress duck under voiceover, uploads mp4 to Supabase `renders` bucket.
7. `agent5_upload.js` — YouTube upload when `AUTOPILOT=true`; else "Awaiting Approval" (dashboard has preview + approve button → `/api/jobs/:id/approve`).

Niche config lives in Supabase `niche_configurations` (rss_feeds, target_sources subreddits, mastodon_tags, lemmy_communities — no `run_trend_sources` column, so the code-default source set applies to all niches). Jobs in `pipeline_logs`.

## Verification workflow (mandatory before every push)
1. `node --check` every touched file, then full sweep: `for f in $(git ls-files '*.js'); do node --check "$f"; done`
2. Boot test: `mv .env .env.bak; OPENAI_API_KEY=test SUPABASE_URL=http://localhost SUPABASE_SERVICE_KEY=test PORT=0 node -e "import('./src/index.js')..."; mv .env.bak .env`
3. Behavior fixes need REAL verification (actual API calls / rendered frames viewed / decoded output) — `node --check` alone has repeatedly missed real bugs.
4. Delete all test artifacts (local files AND Supabase test uploads) before `git add`.

## Environment facts
- Windows 11 dev box; Python at `python` (3.14, real install — NOT the MS Store stub), gTTS installed; local ffmpeg 6.1.1 vs Railway ffmpeg-static 7.0.2.
- `.env` exists locally with real keys (gitignored); duplicate keys in it — LAST occurrence wins with dotenv.
- Railway deploy: nixpacks.toml installs python3+gTTS; single service; env set in Railway Variables tab overrides code defaults.
- Known open items: YouTube Trending needs OAuth re-consent with youtube.readonly scope (`npm run auth:youtube`); PEXELS_API_KEY empty (Pixabay-only footage).
