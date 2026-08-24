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

Everything runs in one Node process at **$0 marginal cost per video** — fully
Gemini-only, no OpenAI dependency at all (the SDK isn't even in
`package.json`):
- **LLM**: Gemini free tier (`GEMINI_API_KEY`) for scripts, quality critic, cuts, format, topic ranking, comment replies. Two tiers only: `smart` (flash-latest) for creative generation, `fast` (flash-lite) for everything else — scoring/rubrics are calibrated against flash-lite specifically. System prompts are module-level constants sent first in every request so Gemini's implicit prompt caching never re-bills a static prefix; per-run context always goes in the user message.
- **TTS**: Gemini TTS free tier (12 natural voices) — chunked synthesis, `gtts` last-resort. ElevenLabs slot for cloned personal voices (Leo, paid/optional).
- **Captions/alignment**: Gemini audio understanding (per-word timestamps), shared helper with backup-key rotation (`transcribeAudioWords`).
- **Vision**: Gemini (stock QA, Leo frame descriptions).
- **Images**: Pollinations (free, no key) for illustrated frames.
- **Render**: in-process `ffmpeg-static` — ken-burns, cross-dissolves, themed captions, hook overlays, ducked music, -14 LUFS.
- **Music/SFX**: Supabase `music_library` (Jamendo sync `npm run music:sync`, multi-source brain `npm run music:brain`) with live fallback search when empty; `sfx_library` via `npm run sfx:sync` (Pixabay Sound Effects). Stock-footage searches are cached 7 days in `material_cache` (quota + latency win).
- **Engagement**: Agent 7 reads and classifies every fresh YouTube comment (one batched Gemini call per video) and replies to questions/compliments in the channel's voice (`editing_style_preset.voiceBrief`). Replies are off by default — flip **AUTO-REPLY** on the dashboard or set `AUTO_ENGAGE=true`.

### Niches
- **Explained** (illustrated explainer shorts — flagship): question-driven sources, curiosity-ranked topics, consistent cartoon frames, comic hook text.
- **Leo** (local cat channel): drop videos into `leo_inbox/` (+ optional same-named `.txt` of what to say), run `npm run leo:sync` — narrated, captioned, hook-overlaid, natural cat audio preserved, cross-post packages created. Schedule with Task Scheduler for daily cadence.
- Plus Viral/News/Food/Psychology/etc., all configured in Supabase and controllable from the dashboard.

### Multiple YouTube channels
Run `npm run auth:youtube` signed into each channel; put each refresh token in the `GOOGLE_CHANNELS` env var as JSON (`{"leo_channel":"1//token..."}`). The dashboard's Channel Routing panel then assigns any niche to any channel, plus per-niche upload cadence (daily/2d/3d/weekly).

`TTS_ENGINE`/`RENDER_ENGINE` also support pointing at external services
(`chatterbox`, `render-api`, etc.) if you've deployed your own, but that's
optional extra infrastructure, not required to run this.

## Requirements

- Node.js ≥ 22
- Python 3 + `pip` (for `gTTS`) — only needed if you explicitly set `TTS_ENGINE=gtts` as the fallback
- Accounts/API keys: Gemini (free), Supabase, Pexels/Pixabay, Google Cloud (YouTube OAuth)

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
| `GEMINI_API_KEY` | everything AI (free tier) — scripts, TTS, alignment, vision |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | job storage, generated asset storage, dashboard state |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | stock footage sourcing |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | YouTube publishing |
| `DASHBOARD_PASSWORD` | protects `/api/*` routes and the dashboard |

Defaults (`TTS_ENGINE=gemini`, `RENDER_ENGINE=ffmpeg`, Pollinations for generated images)
run with zero extra infrastructure and zero marginal cost — change them only if
you've deployed the optional external services documented in `.env.example`.

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
`AUTOPILOT=true`; the engagement cron (Agent 7) runs at 02:00/14:00 UTC.
`VIDEOS_PER_RUN` controls how many videos it attempts per run.

**Runtime ops flags**: `AUTOPILOT` and `AUTO_ENGAGE` can be flipped live from
the dashboard header (persisted in `settings.json`, hot-reloaded — no
redeploy). Env vars are the durable defaults; the dashboard toggle wins until
cleared.

## Deploying (Google Cloud Run — free)

Recommended over Railway: Cloud Run's Always Free tier (180,000 vCPU-seconds
+ 2M requests/month, no time limit, no credit-card-triggered charges as long
as you stay under quota) comfortably covers one video/day plus dashboard
usage, and its "scale to zero between requests" model actually fits this
app's shape — the pipeline is a daily batch job, not something that needs to
sit warm 24/7. `Dockerfile` replaces Railway's `nixpacks.toml` (same Node +
Python3 + gTTS setup, just in a portable format Cloud Run/Render/any other
host understands).

**One real gotcha, already handled in code**: Cloud Run only allocates CPU
to a container while a request is in flight by default. The dashboard's
"Run Full Loop" button hits `POST /api/run`, which fires the pipeline in the
background and returns immediately — correct for a human clicking a button,
but on Cloud Run that would leave the actual multi-minute render CPU-starved
the instant the response goes out. `POST /api/run/scheduled` exists
specifically for the scheduler: it *awaits* the full run before responding,
so Cloud Run keeps CPU allocated for the whole job.

```bash
# One-time setup
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com

# Deploy (builds the Dockerfile via Cloud Build, no local Docker needed)
gcloud run deploy horizon-ai \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout 3600 \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 0 --max-instances 1 \
  --set-env-vars "GEMINI_API_KEY=...,SUPABASE_URL=...,SUPABASE_SERVICE_ROLE_KEY=...,DASHBOARD_PASSWORD=...,PEXELS_API_KEY=...,PIXABAY_API_KEY=...,GOOGLE_CLIENT_ID=...,GOOGLE_CLIENT_SECRET=...,GOOGLE_REFRESH_TOKEN=...,AUTOPILOT=false"
# (set every var from .env.example the same way — Cloud Run env vars work
# identically to Railway's; for secrets you'd rather not put in a shell
# history, use --set-secrets with Secret Manager instead)
```

`--allow-unauthenticated` makes the dashboard URL public — it's still
protected by `DASHBOARD_PASSWORD` (the same auth middleware as everywhere
else), same trust model as Railway.

Then replace Railway's built-in cron with **Cloud Scheduler** calling the
awaited endpoint on the schedule you want (matches `PIPELINE_CRON`'s default
of 03:00 UTC daily below):

```bash
gcloud scheduler jobs create http horizon-daily-run \
  --location us-central1 \
  --schedule "0 3 * * *" \
  --uri "https://YOUR-CLOUD-RUN-URL/api/run/scheduled" \
  --http-method POST \
  --headers "Authorization=Bearer YOUR_DASHBOARD_PASSWORD" \
  --attempt-deadline 1800s
```

Cloud Run's own `node-cron` schedule (`PIPELINE_CRON` in `src/index.js`)
still fires too if the container happens to be warm at that moment, but
since Cloud Run scales to zero when idle, Cloud Scheduler is the trigger
that's actually guaranteed to run — don't rely on the in-process cron alone
on this host.

### Alternative: Railway (legacy)

`railway.json` + `nixpacks.toml` remain in the repo for reference but the
project now deploys to Cloud Run exclusively.

## Project layout

```
src/
  index.js              Express app, cron schedules (pipeline/stats/weekly-learning/engagement), route mounting
  config.js              env → config object
  pipeline/
    agent1_harvester.js  topic sourcing + one-pass candidate re-rank + stock/AI footage sourcing (material-cached) + visual QA
    agent2_scriptwriter.js  scriptwriting + critic-gated revisions + trim/cut calculation
    agent3_audio.js       TTS + word alignment + music pick (library → live multi-source fallback)
    agent4_shotstack.js   render payload assembly (+ SFX stingers from sfx_library)
    agent5_upload.js      YouTube (+ other platform package export) upload
    agent6_clipper.js     long-form → clips (dialogue hook-scoring / audio-peak modes, natural-language describe filter)
    agent7_engage.js      comment read → classify → reply engine (Agent 7)
    formatDecision.js     per-topic format decision (word-clip vs narrated, duration, music register)
    leo.js                local cat-niche engine (`npm run leo:sync`)
    run.js                orchestrates the full pipeline per job
  lib/                    TTS, FFmpeg rendering, LLM router, scoring, learning, etc.
  routes/                 dashboard API endpoints (incl. /api/ops runtime flags, /api/engage)
  dashboard/dashboard.html  the dashboard UI itself
supabase/COMPLETE_SETUP.sql  the entire DB schema (one file, by design)
```

## Content-source notes

- **Pexels**: if `PEXELS_API_KEY` is unset, stock search silently falls back to Pixabay-only — the dashboard diagnostics panel will show Pexels as "Down" until a key is set.
- **Social discovery**: public RSS, platform metadata, trend services, and configured feeds are used to discover topics. They are research inputs, not a licence to reuse third-party video.
- **Long-form clipper**: platform URLs require an explicit confirmation that you own the video or have rights to clip it. For other creators' material, use the platform export or obtain written permission first.
