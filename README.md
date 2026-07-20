# Horizon AI 2.0

Self-hosted, autonomous vertical-video factory. It harvests trending topics,
writes and scores scripts, sources/generates b-roll, synthesizes voiceover,
renders a captioned video in-process (no paid render/TTS services), and
publishes to YouTube (other platforms export as ready-to-post packages until
their posting credentials are configured). A weekly Bayesian job reviews
published performance and feeds it back into topic/format selection.

Jobs scoring below the quality threshold (default 78/100, set against the
critic's measured score distribution: filler content grades ~35-45, strong
scripts ~78-84; fabricated or incoherent content hard-fails at any score) or
with subtitle sync worse than 50ms are rejected before publish — see
`CONTENT_QUALITY_THRESHOLD` / `SUBTITLE_SYNC_PRECISION_MS`.

## How it runs (single service, no satellites)

Everything runs in one Node process, at near-zero marginal cost per video:
- **LLM**: Gemini free tier first (`GEMINI_API_KEY`), OpenAI as automatic paid fallback — scripts, quality critic, cuts, format decisions.
- **TTS**: OpenAI `gpt-4o-mini-tts` (~$0.01/video), chunked synthesis with free `gtts` fallback.
- **Images**: Pollinations (free, no key) for illustrated explainer frames; `gpt-image-1` fallback.
- **Render**: `ffmpeg` via the bundled `ffmpeg-static` npm package — free, in-process, no separate server.
- **Stock footage**: Pexels + Pixabay APIs, vision-QA'd against the script by GPT-4o-mini; zero-match beats get AI cutaways (`ENABLE_AI_CUTAWAY`).
- **Music**: Supabase `music_library`, auto-stockable from Jamendo's free API (`npm run music:sync`).

`TTS_ENGINE`/`RENDER_ENGINE` also support pointing at external services
(`chatterbox`, `render-api`, etc.) if you've deployed your own, but that's
optional extra infrastructure, not required to run this.

## Requirements

- Node.js ≥ 22
- Python 3 + `pip` (for `gTTS`) — only needed if `TTS_ENGINE=gtts` (the default)
- Accounts/API keys: OpenAI, Supabase, Pexels, Pixabay, Google Cloud (YouTube Data API OAuth)

On Windows, make sure `python` (or `python3`) resolves to a **real** Python
install, not the Microsoft Store stub — `python --version` should print a
version number, not open the Store.

## Setup

```bash
git clone https://github.com/<you>/horizon-ai.git
cd horizon-ai
chmod +x setup.sh
./setup.sh          # installs gTTS via pip, npm install, creates .env from .env.example
```

Then edit `.env` and fill in real values — at minimum:

| Variable | Required for |
|---|---|
| `OPENAI_API_KEY` | TTS, Whisper alignment, vision QA, LLM fallback |
| `GEMINI_API_KEY` | free-tier primary LLM (aistudio.google.com) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | job storage, generated asset storage, dashboard state |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | stock footage sourcing |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | YouTube publishing |
| `DASHBOARD_PASSWORD` | protects `/api/*` routes and the dashboard |

Leave `TTS_ENGINE=gtts` and `RENDER_ENGINE=ffmpeg` unless you've deployed the
optional external services — those are the only values that work with zero
extra infrastructure.

Run the Supabase schema once via the Supabase SQL editor: `supabase/COMPLETE_SETUP.sql`
(this is the single source of truth for the schema — don't add separate migration files).

### Getting a Google refresh token

```bash
npm run auth:youtube
```
Follow the printed OAuth URL, then paste the resulting code back in — it prints
a `GOOGLE_REFRESH_TOKEN` to put in `.env`.

## Run

```bash
npm start          # production
npm run dev         # auto-restart on file change
npm run pipeline:once   # run one pipeline pass immediately, skip the cron schedule
```

Then open `http://localhost:8080` (or `?key=<DASHBOARD_PASSWORD>` in the URL,
or an `Authorization: Bearer <DASHBOARD_PASSWORD>` header for API calls) for
the live dashboard: job stream, per-engine diagnostics, cost tracking, niche
management, and manual run/clip triggers.

The pipeline itself runs on `PIPELINE_CRON` (default `0 3 * * *`, UTC) when
`AUTOPILOT=true`. `VIDEOS_PER_RUN` controls how many videos it attempts per run.

## Deploying (Railway)

`railway.json` + `nixpacks.toml` are set up for a single Railway service —
Nixpacks installs Node, Python 3, and `gTTS` during the build, and the app
listens on `PORT` with a `/health` check. Push to your connected repo/branch
and set the same env vars as above in the Railway service's Variables tab.

## Project layout

```
src/
  index.js              Express app, cron schedules, route mounting
  config.js              env → config object
  pipeline/
    agent1_harvester.js  topic sourcing + stock/AI footage sourcing + visual QA
    agent2_scriptwriter.js  scriptwriting + trim/cut calculation
    agent3_audio.js       TTS + music
    agent4_shotstack.js   render payload assembly
    agent5_upload.js      YouTube (+ other platform package export) upload
    agent6_clipper.js     long-form → clips
    formatDecision.js     word-clip vs. sentence-clip caption format decision
    run.js                orchestrates the full pipeline per job
  lib/                    TTS, FFmpeg rendering, scoring, retry, learning, etc.
  routes/                 dashboard API endpoints
  dashboard/dashboard.html  the dashboard UI itself
supabase/COMPLETE_SETUP.sql  the entire DB schema (one file, by design)
```

## Notes / current known gaps

- **Pexels**: if `PEXELS_API_KEY` is unset, stock search silently falls back to Pixabay-only — the dashboard diagnostics panel will show Pexels as "Down" until a key is set.
- **No YouTube/TikTok/Twitch/Kick scraping or downloading**: this project intentionally does not scrape or download from those platforms (no official download API exists for any of them). Sourced footage comes from Pexels/Pixabay/AI-generated images/your own Vimeo uploads only.
