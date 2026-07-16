# HORIZON AI

Autonomous faceless short-form video engine. Daily 03:00 UTC loop: trend
harvest → licensed footage sourcing → GPT-4o looped script + trim points →
ElevenLabs voiceover with word timestamps → Shotstack 9:16 render with active
captions → region-scheduled private YouTube upload.

**Niches:** Gaming/Lore · Aesthetic · Psychology · Travel

## Architecture

```
cron 03:00 UTC ─▶ Agent 1  Reddit/wiki trend scan + Pexels/Pixabay licensed b-roll
                  Agent 2  GPT-4o script (infinite-loop hook) + per-clip trim points
                  Agent 3  ElevenLabs TTS w/ timestamps + music_library pick
                  Agent 4  Shotstack JSON compile → render → poll
                  Agent 5  Regional peak-slot calc → YouTube private+scheduled upload
                     │
                Supabase (pipeline_logs, niche_configurations, music_library, Storage)
                     │
              Command Center dashboard (SSE live stream · 9:16 preview ·
              script overrides · approval flow · integration diagnostics)
```

## Setup

1. **Rotate every API key that was ever pasted into a chat or document.**
   Then create fresh keys and put them in `.env` (copy `.env.example`).
2. **Supabase:** create a project → run `supabase/schema.sql` in the SQL
   editor → create a **public Storage bucket named `renders`** (voiceovers)
   and one named `music`. Upload royalty-free MP3s to `music` and insert rows
   into `music_library` with `energy_level` = High / Suspense / Chill / Wonder
   and a `license_note` recording where each track came from.
3. **Stock footage:** free API keys from pexels.com/api and pixabay.com/api.
4. **YouTube:** in Google Cloud Console, create OAuth credentials
   (Desktop/Web), enable *YouTube Data API v3*, then:
   ```bash
   npm install
   npm run auth:youtube     # approve → paste GOOGLE_REFRESH_TOKEN into .env
   ```
5. **Run:**
   ```bash
   npm start                # server + dashboard + cron
   npm run pipeline:once    # single manual full loop
   ```
   Dashboard: http://localhost:8080 (password = `DASHBOARD_PASSWORD`).

## Deploy (Railway / Render / VPS)

- Push repo (without `.env`) → set all env vars in the host's dashboard.
- Needs a long-running Node 18+ process (not serverless — the cron and SSE
  stream must stay alive). Railway "web service" or a small VPS with pm2 both work.
- Set `SHOTSTACK_ENV=v1` for production renders (stage watermarks output).

## Operating modes

- `AUTOPILOT=true` — full set-and-forget: renders upload themselves into the
  next regional peak slot (India → SE Asia → South Africa → US rotation).
- `AUTOPILOT=false` — everything renders, then holds at **Awaiting Approval**;
  review in the dashboard, edit title/script, press *Approve → Schedule upload*.

## Running the pipeline

The dashboard header has **▶ RUN FULL LOOP**, which fires all active niches
at once (same as the 03:00 UTC cron). Below the header, the **Run single
niche** bar has one button per niche (Gaming/Lore, Aesthetic, Psychology,
Travel) so you can test or trigger one at a time — useful while tuning a
niche's footage keywords or voice, or when you just want one fresh video
without spending render credits on all four.

Both call the same backend routes a script or cron job would:
```
POST /api/run              → runs every active niche
POST /api/run/:niche       → runs one niche, e.g. /api/run/Aesthetic
```
`:niche` must match a `niche_name` value in Supabase's `niche_configurations`
table exactly, including the slash in `Gaming/Lore` (the dashboard buttons
already encode this correctly).

## Testing checklist (recommended before enabling Autopilot)

1. Set `AUTOPILOT=false` and confirm it in the dashboard toggle.
2. Confirm `music_library` has at least one track per energy level
   (High / Suspense / Chill / Wonder) — otherwise renders succeed silently
   without music.
3. Click a single niche button (start with **Aesthetic** — lowest legal risk,
   easiest to sanity-check visually) rather than Run Full Loop.
4. Watch the Live Status Stream end-to-end — Agent 1 through Agent 4 usually
   takes 3-8 minutes, most of it Shotstack render polling.
5. When the job reaches **Awaiting Approval**, select it in the Preview
   Platform dropdown and review: loop hook/tail flow, caption sync, footage
   mood match, title/description/tags tone.
6. Only after a few clean reviews, flip `AUTOPILOT=true` (Railway → Variables)
   and let the daily cron run unattended.

**Shotstack environment reminder:** `SHOTSTACK_ENV=stage` (sandbox, free,
watermarked) is fine for local testing. Production uploads need
`SHOTSTACK_ENV=v1` on Railway, which requires a paid Shotstack plan — confirm
your account is upgraded before relying on `v1` renders for real MythosVibe
uploads, otherwise `v1` calls will fail rather than silently downgrade.

## Compliance guardrails built in

- **Footage:** only Pexels/Pixabay licensed clips ever enter the timeline;
  provenance stored per-job in `sourced_media_urls`.
- **Scripts:** wiki/lore content is paraphrase-only (enforced in the system
  prompt) — satisfies CC-BY-SA and performs better than read-aloud anyway.
- **AI disclosure:** uploads set `containsSyntheticMedia: true`, YouTube's
  required flag for synthetic voiceovers.
- **RLS:** stays enabled; the backend's service-role key bypasses it without
  exposing tables publicly.
- **Games Workshop note:** 40k lore is enforceable IP with an aggressive
  rights-holder — keep GW content commentary-style and diversified with other
  franchises (Elden Ring, Fallout, Zelda-likes are safer).

## Quota notes

- YouTube upload costs ~1,600 quota units; default 10,000/day allows ~6
  uploads. 4/day (one per niche) fits comfortably.
- Shotstack stage environment is free but watermarked — switch to `v1` when live.
