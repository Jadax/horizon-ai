## Active Rules
- Keep scripts modular; reuse existing lib/pipeline code — never duplicate helpers.
- Prose in responses: 1-3 lines; output code/diffs directly.
- Supabase schema: ONE file — `supabase/COMPLETE_SETUP.sql`. Never separate migrations. No new columns without asking (jsonb fields like editing_style_preset are the extension point).
- Every commit: bump `package.json` version (semver), short commit summary, then `GIT_TERMINAL_PROMPT=0 git push origin master` — no confirmation.
- No new PAID API/service deps without asking (current paid-optional: ElevenLabs voice clone).
- YouTube/Twitch/Kick metadata discovery via yt-dlp is permitted.
- SCRAPE POLICY: only download platform video when the operator owns it or has explicit rights; public accessibility is not a redistribution licence.
- Never bypass paywalls, logins, DRM, or terms-of-service blocks, and never commit third-party media files to the repository.

# TOKEN EFFICIENCY & CONTEXT OPTIMIZATION DIRECTIVE

You are an expert software engineer optimized for token efficiency, accuracy, and clear execution. Apply the following strict constraints to ALL system interactions and responses:

## 1. Output Conciseness (Save Output Tokens)
- Be extremely direct and concise. Omit pleasantries, repetitive preamble, recap summaries, and fluff.
- Lead with the direct solution, code change, or direct answer immediately.
- Use succinct Markdown lists over verbose paragraphs. Explain *why* in 1 sentence max per change.
- Never output full files when modifying code. Produce ONLY the targeted file diffs or explicit function block changes with minimal surrounding context.

## 2. Input & Context Management (Save Input Tokens)
- Assume the system/code context provided at the start of the session is cached and static.
- Do not repeat or echo back code snippets, documentation, or rules provided in previous context turns.
- If asked to perform a simple task, perform it directly in the minimum necessary steps without requesting or reading extraneous repository files.

## 3. Tool & Execution Rules
- Prioritize single-turn completion. Verify work internally before submitting to prevent iterative error loops.
- Use target-specific file searches (grep/glob) rather than broad directory listings or full-file reads.
- When generating JSON or structured schemas, output strict raw format without prose wrapper text.

## Stack (near-$0/video, verified live)
| Function | Primary (free) | Fallback |
|---|---|---|
| LLM text | Gemini ONLY (lib/llm.js llmJson). Tiers: `smart`=flash-latest for CREATIVE GENERATION only (writeScript, clipPlanning); `fast`=flash-lite for ALL classification/scoring/ranking/trimming/copy — rubrics are calibrated on flash-lite | none |
| TTS | Gemini TTS `gemini-2.5-flash-preview-tts` (freeTTS 'gemini', 12 voices) | gtts (python) |
| Word alignment + clipper transcription | shared `transcribeAudioWords` (llm.js, key rotation) | none |
| Vision (QA, Leo frames) | Gemini inline images (llm.js llmVision) | none |
| Images (illustrated frames) | Pollinations FLUX, no key | none |
| Stock footage | Pexels/Pixabay APIs + vision QA; searches cached 7d in `material_cache` | AI cutaways (cap 4) |
| Music | Supabase music_library (Jamendo `music:sync`, multi-source `music:brain`, live fallback search in pickMusic) | renders without music |
| SFX | `sfx_library` via `npm run sfx:sync` (Pixabay SFX API) | no stingers |
| Render | in-process ffmpeg-static | — |
| Personal voice (Leo) | — | ElevenLabs clone (LEO_VOICE_ID, paid) |

LLM token discipline (enforced in lib/llm.js header): system prompts = module-level constants, sent FIRST (Gemini implicit prefix caching — never interpolate per-run data into system strings; dynamic context goes in the user message). Revision payloads send only fields being rewritten. One merged candidate-rerank call per run (agent1), one batched classify call per video (agent7).

## Pipeline per job (`src/pipeline/run.js` → runPipelineForNiche)
1. `agent1_harvester.js` — topics from `src/sources/*` (RSS, Reddit .rss w/ cache+pacing, Mastodon(bot-filtered)/Lemmy, HN Algolia, Wikimedia pageviews, Bluesky whats-hot, Google Trends, GDELT). Ranked by `lib/trendScoring.js`; ONE merged LLM re-rank (curiosity+grounding+visualability+teachable+evergreen; gates unproducible topics; explainer-weighted); returns top + alternates (orchestrator falls back to next topic if quality gate rejects all drafts). Wikipedia lore grounding incl. article extract.
2. `formatDecision.js` — word-clip vs narrated, duration, mood (niche pin = preset.musicEnergy camelCase).
3. `agent2_scriptwriter.js` — script + revisions targeting weakest critic dimensions; gate = `lib/contentQuality.js` (fast-tier critic, calibrated: filler ~25-45, strong ~78-90; threshold 78; blocking_issues hard-fail any score). BANNED_WORDS single source: lib/utils.js (prompt injects same list; sanitizer enforces post-hoc).
4. `agent1.harvestFootage` — illustrated mode (`preset.visualMode="illustrated"`): every beat → style-consistent cartoon frame, no stock; else cached stock search + QA + cutaways.
5. `agent3_audio.js` — chunked TTS (≤280 chars/chunk, 2 tries, gtts 3rd) → alignment via transcribeAudioWords ("audio incomplete" = re-synthesize). pickMusic falls back to live multi-source search when library empty for that energy, banks winner into music_library.
6. `agent4_shotstack.js` + `lib/freeVideoRender.js` — ffmpeg: concat legs; ken-burns zoompan (4 rotating motions) on `type:"image"`; xfade cross-dissolves for all-image sets (duration-exact); ONE `ass=` filter (NEVER chained drawtext — breaks at 80+ captions); per-niche caption colors (`preset.caption.color`) + yellow Hook overlays; hook/payoff SFX from sfx_library; music sidechain-ducked; loudnorm -14 LUFS; uploads mp4+thumbs to Supabase `renders`.
7. `agent5_upload.js` — YouTube upload/schedule when AUTOPILOT=true; else "Awaiting Approval" (dashboard preview+approve; GET/POST /api/jobs/:id/approve; Telegram one-tap if TELEGRAM_* set). Multi-channel: preset.targetChannels / niche.target_channel → linked_channels or GOOGLE_CHANNELS env.
8. `agent7_engage.js` (cron 02:00/14:00 UTC + POST /api/engage) — reads fresh comments on recent published videos, ONE batched Gemini classify per video (question/compliment/critique/spam/off_topic + drafts), replies in voiceBrief voice to question/compliment only; dedupe ledger = `engagement` table; reply posting gated by AUTO_ENGAGE (reads always recorded).
9. Analytics: `lib/performanceTracker.js` (6h stats refresh) + `lib/closedLoopLearner.js` (weekly, feeds title patterns + source weights back).

## Leo (local cat niche — `npm run leo:sync`, src/pipeline/leo.js)
Scans `leo_inbox/` (videos live on the dev box, not Railway). **v3 clip-library engine**: each inbox video is deeply analyzed via Gemini Vision (frames sampled every 3s across the full video) to find ALL clippable moments — not just one compilation, but 3-5+ potential shorts per source video. Each run picks ONE clip from ONE video, renders it as a standalone short, and marks it used in `leo_video_library`. Subsequent runs pick the next unused clip from the same video (or a different one). Videos are never posted from back-to-back — cooldown enforced. Analysis persists across runs so re-analysis is free. Falls back to multi-clip compilation (`processCompilation`) if the library approach fails. Publishes to Leo's YouTube channel (`@LeoTheCat-x6q`) and creates packages for Instagram + TikTok. Output QC → publish_targets → Awaiting Approval / autopilot upload.
Leo's niche row now has `active: true` (dashboard visibility) but `editing_style_preset.localFolder: true` — `run.js`'s `runFullPipeline` skips any niche with that flag before attempting the standard RSS/Reddit harvest pipeline (Leo has zero topic sources by design, so the standard pipeline always threw). Same guard also skips any OTHER niche with zero configured sources and no reliance on the global trending pool, as a defensive net. Only `npm run leo:sync` actually drives Leo.

## Known operational blockers (2026-07, verified live — need operator action, not code)
- **YouTube refresh token is expired/revoked** (`invalid_grant` from Google's token endpoint, confirmed via direct `channels.list` call) — blocks YouTube Trending AND every actual upload in autopilot/approve. Fix: `npm run auth:youtube` (interactive OAuth, can't be done headlessly).
- `music_library` has no unique constraint on `(title, energy_level)` — `music:sync`/`music:brain` no longer use `.upsert(..., {onConflict})` (was throwing "no unique or exclusion constraint matching" on every track, verified live); they select-then-insert/update instead. An optional `CREATE UNIQUE INDEX IF NOT EXISTS` was added to COMPLETE_SETUP.sql for manual dedup convenience only — not required for the code to work.

## Niche config (Supabase `niche_configurations`)
Columns: niche_name, active, target_sources(subreddits), rss_feeds, mastodon_tags, lemmy_communities, lore_wiki_apis, footage_keywords, voice_profile_id, editing_style_preset(jsonb), language, trend_region, target_duration_min/max_seconds, target_channel, social_rss_feeds. NO run_trend_sources column.
editing_style_preset keys: wordClipMode, transitions, caption{style,color}, visualMode("illustrated"), explainerMode, trendSources[] (restricts source types), musicEnergy pin, cadenceDays, qualityThreshold, uploadHourUtc, voiceBrief (brand voice: agent2 scripts + agent7 replies), wpm, geminiVoice, persona (Leo), petMode.
Jobs → `pipeline_logs`; cross-post → `publish_targets`; music → `music_library`; sfx → `sfx_library`; clips → `clip_jobs` (source_type incl. ytdlp_own); engagement ledger → `engagement`; stock-search cache → `material_cache` (7d TTL).
Ops flags: GET/POST `/api/ops` — autopilot + autoEngage runtime toggles (settings.json-backed, hot-applied; env vars are defaults).

## Dashboard (src/dashboard/dashboard.html, dark theme)
Run buttons per niche, trending explorer, live SSE stream, preview+approve queue, publish-target packages (TikTok/IG manual until their APIs approved), diagnostics (engine-aware checks), cost tracker (legacy estimate), Channel Routing panel: per-niche language/channel/cadence + channel-linking how-to. Auth: Bearer DASHBOARD_PASSWORD or ?key=.

## Verification workflow (mandatory before every push)
1. Full sweep: `for f in $(git ls-files '*.js'); do node --check "$f"; done`
2. Boot: `mv .env .env.bak; GEMINI_API_KEY=test SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=test PORT=0 node -e "import('./src/index.js')..."; mv .env.bak .env`
3. Behavior changes need REAL verification: live API call / rendered frame Read / pixel-diff / bandpass audio check — node --check alone has repeatedly missed real bugs.
4. Delete ALL test artifacts: local files AND Supabase storage AND test pipeline_logs rows, before `git add`.

## Environment facts
- Windows 11 dev box; real Python at `python` (3.14) with gTTS; local ffmpeg 6.1.1 (gyan) vs Cloud Run ffmpeg-static 7.0.2 — the drawtext chain bug only manifested on 7.0.2; always use the ass= path.
- `.env` local with real keys (gitignored; dotenv: LAST duplicate wins). Deploy env overrides code defaults — stale deploy vars (TTS_ENGINE, CONTENT_QUALITY_THRESHOLD) can shadow new code defaults. Deploy: `gcloud run deploy --source .` (service horizon-ai, us-central1); scheduler hits /api/run/scheduled (awaits full run — keeps Cloud Run CPU alive).
- Known open: YouTube Trending needs OAuth re-consent w/ youtube.readonly (`npm run auth:youtube`); Instagram Reels posting requires INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_BUSINESS_ID (Facebook App → IG Business account → long-lived token); TikTok Content Posting API blocked on app approval (client built, ready when approved); Jamendo sync untested (needs free JAMENDO_CLIENT_ID); Telegram untested (needs bot token).
- Reddit unauthenticated: .rss only (.json 403s), ~10 req/min budget — cache+pacing in sources/reddit.js.
- Gemini free models for THIS key: gemini-flash-latest (throttles), gemini-flash-lite-latest (reliable), gemini-2.5-flash-preview-tts. No OpenAI — zero credits, pipeline is Gemini-only.
