## Active Rules
- Keep scripts modular; reuse existing lib/pipeline code — never duplicate helpers.
- Prose in responses: 1-3 lines; output code/diffs directly.
- Supabase schema: ONE file — `supabase/COMPLETE_SETUP.sql`. Never separate migrations. No new columns without asking (jsonb fields like editing_style_preset are the extension point).
- Every commit: bump `package.json` version (semver), short commit summary, then `GIT_TERMINAL_PROMPT=0 git push origin master` — no confirmation.
- No new PAID API/service deps without asking (current paid-optional: ElevenLabs voice clone).
- YouTube/Twitch/Kick metadata discovery via yt-dlp is permitted.
- SCRAPE POLICY: only download platform video when the operator owns it or has explicit rights; public accessibility is not a redistribution licence.
- Never bypass paywalls, logins, DRM, or terms-of-service blocks, and never commit third-party media files to the repository.

## Response & token discipline
- Lead with the answer/diff. No preamble, recap, or fluff. Lists over paragraphs; ≤1 why-sentence per change.
- Never output whole files — targeted diffs/blocks only. Strict raw JSON without prose wrappers.
- Grep/glob before reading; don't re-read or echo context you already have. Single-turn completion; verify internally before submitting.

## Stack (near-$0/video, Gemini-only)
| Function | Primary (free) | Fallback |
|---|---|---|
| LLM text (scripts, critic, trims, format, candidate rerank) | Gemini flash-latest → flash-lite (`lib/llm.js llmJson`; optional maxTokens cap for small outputs) | none |
| TTS | Gemini TTS `gemini-2.5-flash-preview-tts` (freeTTS 'gemini') | gtts (python) |
| Word alignment | Gemini audio understanding via `lib/geminiTranscribe.js` (shared w/ Agent 6; multi-key rotation) | proportional timing (last resort) |
| Vision | Gemini inline images (`llmVision`) | none |
| Images (illustrated frames) | Pollinations FLUX, no key | none |
| Stock footage | Pexels/Pixabay + vision QA; results cached in `material_cache` (7d TTL) | AI cutaways (cap 4) |
| Music | Supabase music_library; live multi-source search (Pixabay/FMA/Incompetech via musicBrain) when empty | render silent |
| SFX | sfx_library (`npm run sfx:sync`, Pixabay SFX API) | no stinger |
| Render | in-process ffmpeg-static | — |
| Personal voice (Leo) | — | ElevenLabs clone (LEO_VOICE_ID, paid) |

## Pipeline per job (`src/pipeline/run.js`)
1. **agent1_harvester** — topics from `src/sources/*` (RSS, Reddit .rss w/ cache+pacing, Mastodon/Lemmy bot-filtered, HN, Wikimedia pageviews, Bluesky, Google Trends, GDELT, yt-dlp search). Ranked by `lib/trendScoring.js` (batched velocity lookups); ONE combined LLM rerank (curiosity × production-readiness). Topic queue falls through on gate failures.
2. **formatDecision** — word-clip vs narrated, duration, music energy+brief (per-niche prompt slice; niche pins via preset.musicEnergy).
3. **agent2_scriptwriter** — script + revisions targeting weakest critic dimensions; revision payloads carry script/title/hook only (not visual_plan). Gate = `lib/contentQuality.js` (filler ~25-45, strong ~78-90; threshold 78 default; blocking_issues hard-fail). Illustrated niches: drawable beats + ALL-CAPS `overlay` hook text. Preset.voiceBrief injects brand voice.
4. **agent1.harvestFootage** — illustrated mode renders every beat as a cartoon frame; else stock (+material_cache) + vision QA + AI cutaways.
5. **agent3_audio** — chunked TTS (≤280 chars/chunk incl. Hindi danda; attempts 1-2 strict-align, gtts 3rd) → alignment (strict = re-synthesize trigger; proportional only after final attempt). Language threaded (`hi` supported).
6. **agent4_shotstack + lib/freeVideoRender** — ffmpeg concat; ken-burns zoompan on images; xfade for all-image sets; ONE `ass=` filter (NEVER chained drawtext); per-niche caption colors + Hook overlays; ducked music; loudnorm -14 LUFS; uploads to Supabase `renders`.
7. **agent5_upload** — AUTOPILOT=true → upload/schedule (multi-channel via preset.targetChannels → `lib/linkedChannels.js` tokens); else Awaiting Approval (dashboard approve, Telegram one-tap). IG/TikTok auto-post when their tokens exist.
8. **agent7_engage** — twice-daily cron + POST /api/engage: reads fresh comments on published videos (<21d), one batched classify pass (question/compliment/critique/spam/off-topic), replies to questions/compliments in channel voice (preset.voiceBrief) via comments.insert; ledger in `engagement` table dedupes + audits; AUTO_ENGAGE gates posting (read-only otherwise).
9. Analytics — `performanceTracker` (6h stats, integer-hour upload buckets) + `closedLoopLearner` (weekly title-pattern/source-weight feedback).

## Agent 6 clipper (`agent6_clipper.js`) + routes/clips.js
upload / cc_licensed / vimeo_own / ytdlp_own sources. Always converts audio → mono mp3 (`lib/geminiTranscribe.toTranscribableMp3`) before Gemini transcription. Dialogue mode (speech ≥15%): hook-scored transcript clips, honors natural-language `describe` search intent (stored at clip_plan.describe). Action mode: audio peaks → punch-ins; callouts batched in ONE LLM call. QC = real artifact math (`buildClipQualityReport`), never fabricated scores.

## Leo (`npm run leo:sync`, src/pipeline/leo.js)
v3 clip-library engine: deep-analyzes each inbox video ONCE (frames every ~3s → all clippable moments persisted to `leo_video_library`); each run renders ONE unused clip as a standalone short, marks it used immediately after successful schedule (duplicate-post guard), cooldown between posts from same source, exhausted videos marked (never re-analyzed). QC temp files go to OS tmpdir, not inbox. Publishes to @LeoTheCat-x6y channel + IG/TikTok packages. Niche row has `editing_style_preset.localFolder:true` — runFullPipeline skips it (zero topic sources by design); only this script drives Leo. (Old v2 compilation path deleted in 3.16.0.)

## Schema & dashboard
niche_configurations columns: niche_name, active, target_sources(subreddits), rss_feeds, mastodon_tags, lemmy_communities, lore_wiki_apis, footage_keywords, social_rss_feeds, voice_profile_id, target_channel, trend_region, language, target_duration_min/max_seconds, active, editing_style_preset(jsonb). NO run_trend_sources column.
editing_style_preset keys: wordClipMode, transitions, caption{style,color}, visualMode("illustrated"), explainerMode, trendSources[], musicEnergy, cadenceDays, uploadHourUtc, qualityThreshold, persona (Leo), petMode, voiceBrief, targetChannels/targetInstagramChannels/targetTiktokChannels, variants, localFolder, geminiVoice.
Other tables: pipeline_logs (jobs), publish_targets (cross-post), music_library, sfx_library, material_cache, engagement, clip_jobs (source_type CHECK incl ytdlp_own), leo_video_library.
Dashboard: run buttons per niche (DB-driven bar), trending explorer, SSE stream, preview+approve, publish packages, diagnostics, cost tracker (legacy estimate), Channel Routing panel, Auto-Engagement panel, AUTOPILOT/AUTO-REPLY runtime toggles (GET/POST /api/ops — settings.json override → env → default). Auth: Bearer DASHBOARD_PASSWORD or ?key= (timing-safe compare).

## Verification workflow (mandatory before every push)
1. Full sweep: every tracked .js through `node --check`.
2. Boot test: dummy env (`GEMINI_API_KEY=test SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=test PORT=0 node -e "import('./src/index.js')"`) with .env temporarily moved aside.
3. Behavior changes need REAL verification (live API call / rendered frame Read / pixel-diff / bandpass audio) — node --check alone has missed real bugs.
4. Delete ALL test artifacts (local, Supabase storage, test pipeline_logs rows) before `git add`.

## Environment facts
- Windows 11 dev box; real Python at `python` (gTTS); local ffmpeg 6.1.1 vs container ffmpeg-static 7.x — always use the ass= path (drawtext chains break on 7.x).
- `.env` local, gitignored (dotenv: LAST duplicate wins). Deploy env overrides code defaults — stale deploy vars can shadow new code defaults.
- Deploy: Google Cloud Run only (Railway service deleted). `gcloud run deploy horizon-ai --source . --region us-central1 --project horizon-ai-502610`. Scheduler should call `/api/run/scheduled` (awaits full run so CPU stays allocated). In-process node-cron fires only while warm.
- Reddit unauthenticated: .rss only (.json 403s), ~10 req/min budget — cache+pacing in sources/reddit.js.
- Gemini free models for THIS key: gemini-flash-latest (throttles), gemini-flash-lite-latest (reliable), gemini-2.5-flash-preview-tts. No OpenAI.

<!-- ── VOLATILE OPS STATUS: edit freely below this line; everything above is stable and cache-friendly ── -->

## Open blockers / operator TODOs (update as things change)
- YouTube refresh token expired (`invalid_grant`) — blocks Trending + uploads until interactive `npm run auth:youtube`.
- Instagram Reels needs INSTAGRAM_ACCESS_TOKEN + BUSINESS_ID; TikTok posting blocked on app approval (client ready); Jamendo sync untested (free JAMENDO_CLIENT_ID); Telegram untested (needs bot token).
- AUTOPILOT=false + AUTO_ENGAGE=false are the deliberate safe states; flip live via dashboard toggles (no redeploy).
