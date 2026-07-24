## Active Rules
- Keep scripts modular; reuse existing lib/pipeline code — never duplicate helpers.
- Prose in responses: 1-3 lines; output code/diffs directly.
- Supabase schema: ONE file — `supabase/COMPLETE_SETUP.sql`. Never separate migrations. No new columns without asking (jsonb fields like editing_style_preset are the extension point).
- Every commit: bump `package.json` version (semver), short commit summary, then `GIT_TERMINAL_PROMPT=0 git push origin master` — no confirmation.
- No new PAID API/service deps without asking (current paid-optional: OpenAI fallback, ElevenLabs voice clone).
- YouTube/Twitch/Kick downloading via yt-dlp is permitted for content YOU own (your own channels, your own videos). Platform export features are the preferred path; yt-dlp is the programmatic fallback for owner content. Never download or scrape content you don't have rights to.

# TOKEN EFFICIENCY & CONTEXT OPTIMIZATION D IRECTIVE

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
| LLM text (scripts, critic, trims, format, curiosity rank) | Gemini flash-latest → flash-lite (lib/llm.js llmJson) | OpenAI gpt-4o/mini |
| TTS | Gemini TTS `gemini-2.5-flash-preview-tts` (freeTTS 'gemini', 12 voices) | openai → gtts (python) |
| Word alignment (captions) | Gemini audio understanding (agent3 alignWithGemini) | whisper-1 → segment rebuild |
| Vision (QA, Leo frames) | Gemini inline images (llm.js llmVision) | gpt-4o-mini |
| Images (illustrated frames) | Pollinations FLUX, no key | gpt-image-1 medium |
| Stock footage | Pexels/Pixabay APIs + vision QA | AI cutaways (cap 4) |
| Music | Supabase music_library (Jamendo sync: `npm run music:sync`) | renders without music |
| Render | in-process ffmpeg-static | — |
| Personal voice (Leo) | — | ElevenLabs clone (LEO_VOICE_ID, paid) |

## Pipeline per job (`src/pipeline/run.js` → runPipelineForNiche)
1. `agent1_harvester.js` — topics from `src/sources/*` (RSS, Reddit .rss w/ cache+10s pacing, Mastodon(bot-filtered)/Lemmy, HN Algolia, Wikimedia pageviews, Bluesky whats-hot, Google Trends, GDELT). Ranked by `lib/trendScoring.js`; explainer niches re-ranked by LLM curiosity score; returns top + alternates (orchestrator falls back to next topic if quality gate rejects all drafts). Wikipedia lore grounding incl. article extract.
2. `formatDecision.js` — word-clip vs narrated, duration, mood (niche can pin musicEnergy).
3. `agent2_scriptwriter.js` — script + revisions targeting weakest critic dimensions; gate = `lib/contentQuality.js` (calibrated: filler ~25-45, strong ~78-90; threshold 78; blocking_issues hard-fail any score). Illustrated niches: drawable scene beats + per-beat ALL-CAPS `overlay` hook text (no written words in image prompts).
4. `agent1.harvestFootage` — illustrated mode (`preset.visualMode="illustrated"`): every beat → style-consistent cartoon frame, no stock; else stock+QA+cutaways.
5. `agent3_audio.js` — chunked TTS (≤280 chars/chunk, 2 tries, gtts 3rd) → alignment (gemini→whisper; sparse word lists rebuilt from segments; "audio incomplete" = re-synthesize).
6. `agent4_shotstack.js` + `lib/freeVideoRender.js` — ffmpeg: concat legs; ken-burns zoompan (4 rotating motions) on `type:"image"`; xfade cross-dissolves for all-image sets (duration-exact); ONE `ass=` filter (NEVER chained drawtext — breaks at 80+ captions); per-niche caption colors (`preset.caption.color`: white/cream/yellow/mint/sky/pink) + yellow Hook style overlays; music sidechain-ducked; `keepSourceAudio` mixes clip 0's own audio (pet videos); loudnorm -14 LUFS; uploads mp4+thumbs to Supabase `renders`.
7. `agent5_upload.js` — YouTube upload/schedule when AUTOPILOT=true; else "Awaiting Approval" (dashboard preview+approve; GET/POST /api/jobs/:id/approve; Telegram one-tap via lib/telegram.js if TELEGRAM_* set). Multi-channel: niche.target_channel → GOOGLE_CHANNELS refresh token (config.getChannelToken).
8. Analytics: `lib/performanceTracker.js` (6h stats refresh) + `lib/closedLoopLearner.js` (weekly, feeds title patterns + source weights back).

## Leo (local cat niche — `npm run leo:sync`, src/pipeline/leo.js)
Scans `leo_inbox/` (videos live on the dev box, not Railway). **v3 clip-library engine**: each inbox video is deeply analyzed via Gemini Vision (frames sampled every 3s across the full video) to find ALL clippable moments — not just one compilation, but 3-5+ potential shorts per source video. Each run picks ONE clip from ONE video, renders it as a standalone short, and marks it used in `leo_video_library`. Subsequent runs pick the next unused clip from the same video (or a different one). Videos are never posted from back-to-back — cooldown enforced. Analysis persists across runs so re-analysis is free. Falls back to multi-clip compilation (`processCompilation`) if the library approach fails. Publishes to Leo's YouTube channel (`@LeoTheCat-x6q`) and creates packages for Instagram + TikTok. Output QC → publish_targets → Awaiting Approval / autopilot upload. Leo niche row exists but active=false (cron must not harvest it).

## Niche config (Supabase `niche_configurations`)
Columns: niche_name, active, target_sources(subreddits), rss_feeds, mastodon_tags, lemmy_communities, lore_wiki_apis, footage_keywords, voice_profile_id, editing_style_preset(jsonb), language, trend_region, target_duration_min/max_seconds, target_channel, social_rss_feeds. NO run_trend_sources column.
editing_style_preset keys: wordClipMode, transitions, caption{style,color}, visualMode("illustrated"), explainerMode, trendSources[] (restricts source types), musicEnergy pin, cadenceDays (dashboard-set; daily loop skips inside window), persona (Leo), petMode.
Jobs → `pipeline_logs`; cross-post → `publish_targets`; music → `music_library`; clips → `clip_jobs`.

## Dashboard (src/dashboard/dashboard.html, dark theme)
Run buttons per niche, trending explorer, live SSE stream, preview+approve queue, publish-target packages (TikTok/IG manual until their APIs approved), diagnostics (engine-aware checks), cost tracker (legacy estimate), Channel Routing panel: per-niche language/channel/cadence + channel-linking how-to. Auth: Bearer DASHBOARD_PASSWORD or ?key=.

## Verification workflow (mandatory before every push)
1. Full sweep: `for f in $(git ls-files '*.js'); do node --check "$f"; done`
2. Boot: `mv .env .env.bak; OPENAI_API_KEY=test SUPABASE_URL=http://localhost SUPABASE_SERVICE_KEY=test PORT=0 node -e "import('./src/index.js')..."; mv .env.bak .env`
3. Behavior changes need REAL verification: live API call / rendered frame Read / pixel-diff / bandpass audio check — node --check alone has repeatedly missed real bugs.
4. Delete ALL test artifacts: local files AND Supabase storage AND test pipeline_logs rows, before `git add`.

## Environment facts
- Windows 11 dev box; real Python at `python` (3.14) with gTTS; local ffmpeg 6.1.1 (gyan) vs Railway ffmpeg-static 7.0.2 — the drawtext chain bug only manifested on 7.0.2; always use the ass= path.
- `.env` local with real keys (gitignored; dotenv: LAST duplicate wins). Railway env overrides code defaults — stale Railway vars (TTS_ENGINE, CONTENT_QUALITY_THRESHOLD) can shadow new code defaults.
- Railway: single service, nixpacks installs python3+gTTS, /health check.
- Known open: YouTube Trending needs OAuth re-consent w/ youtube.readonly (`npm run auth:youtube`); Instagram Reels posting requires INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_BUSINESS_ID (Facebook App → IG Business account → long-lived token); TikTok Content Posting API blocked on app approval (client built, ready when approved); Jamendo sync untested (needs free JAMENDO_CLIENT_ID); Telegram untested (needs bot token).
- Reddit unauthenticated: .rss only (.json 403s), ~10 req/min budget — cache+pacing in sources/reddit.js.
- Gemini free models for THIS key: gemini-flash-latest (throttles), gemini-flash-lite-latest (reliable), gemini-2.5-flash-preview-tts. gpt-image-1 needs no org verification but account must have credit.