# HORIZON AI

Autonomous faceless short-form video engine. Daily 03:00 UTC loop: trend
harvest → licensed footage sourcing → GPT-4o looped script + trim points →
ElevenLabs voiceover with word timestamps → Shotstack 9:16 render with active
captions → region-scheduled private YouTube upload.

**Niches:** Gaming/Lore · Aesthetic · Psychology · Travel · News · Food

## Architecture (as of this update)

The codebase is organized by concern so each piece is easy to find and
change in isolation:

```
src/
  index.js              thin server bootstrap: auth, SSE stream, cron, route mounting
  config.js             env var loading + validation
  supabase.js           DB client + event bus (powers the Live Status Stream)
  pipeline/
    run.js               orchestrates the 5 agents per niche
    agent1_harvester.js  thin orchestrator: calls src/sources/*, ranks via trendScoring
    agent2_scriptwriter.js  GPT script + title-engineering + trim calculation
    agent3_audio.js      ElevenLabs voiceover + music pick
    agent4_shotstack.js  Shotstack JSON compile + render + poll
    agent5_upload.js     regional scheduling + YouTube upload
  sources/               ONE FILE PER HARVESTING INTEGRATION — easy to add more
    rss.js               generic publisher-feed reader
    googleTrends.js       Google Trends + Google News
    gdelt.js              GDELT global news dataset
    youtubeTrending.js    YouTube's own trending chart
    fediverse.js          Mastodon + Lemmy (open, no-auth hidden gems)
    reddit.js             best-effort Reddit + MediaWiki lore search
  lib/
    trendScoring.js       the self-adjusting "what's about to go viral" engine
  routes/                 ONE FILE PER ROUTE GROUP
    jobs.js               list/override/approve/retry
    run.js                manual pipeline triggers
    trending.js           ad-hoc trend explorer + diagnostics
    costs.js              spend tracker
  dashboard/
    dashboard.html         the Command Center UI
```

## Topic sourcing & the trend-scoring engine

Reddit deprecated unauthenticated `.json` access in May 2026 (commercial API
now costs $12k/year minimum — see `DEPLOYMENT_NOTES.md`). Rather than lean
on one replacement, Agent 1 now pulls from many independent free, no-auth
sources per niche and hands everything to `src/lib/trendScoring.js`, which:

1. **Detects cross-source corroboration** — the same story appearing across
   an RSS feed AND Google Trends AND a fediverse post is a strong signal
   something is *becoming* viral but hasn't peaked yet, which is exactly the
   "hasn't hit viral status" window you want to catch rather than yesterday's
   already-covered news.
2. **Weighs freshness and specificity** — vague/generic headlines score
   lower than ones with a real name, number, or concrete claim.
3. **Self-adjusts source-reliability weights over time**, stored in the
   `trend_rules` table — a source whose picks keep getting corroborated by
   others earns more trust; one that never corroborates gets nudged down.
   This is a genuine, if modest, self-updating mechanism today. The bigger
   future step — closing the loop against ACTUAL video performance pulled
   from YouTube Analytics after a video has had time to breathe — isn't
   built yet (it needs a different API and a delay window), but the schema
   already stores what's needed to bolt it on later. This is flagged
   directly in `trendScoring.js`'s header comment, not a hidden gap.

Sources currently wired, by niche:
- **Every niche:** publisher RSS feeds (see `migration_harvesting_expansion.sql`
  for the full list — dozens of real feeds, not a handful), Google Trends,
  YouTube Trending, Mastodon hashtags, Lemmy communities
- **News specifically:** + GDELT (a genuinely underused free global news
  dataset) + Google News' top-stories feed, including **India-focused
  sources** (Times of India, NDTV, Hindustan Times) — India is the single
  largest Shorts-consuming market and was previously unaddressed
- **Gaming/Lore:** wiki lore-grounding via MediaWiki search (Fandom/wiki.gg)
- **Reddit:** kept everywhere as a harmless best-effort bonus, usually 403s

### Ad-hoc trend check (no pipeline run required)

The dashboard's **🔥 Check What's Trending** button hits `/api/trending`,
which runs the exact same harvesting sources above and shows the full
ranked list for a niche — with zero OpenAI/ElevenLabs/Shotstack cost, since
it's just the free harvesting layer. Use it to browse what's out there
before committing to a full render.

## What's NOT wired in, and why (read this before assuming a feature is missing)

- **Instagram and TikTok are not scraped.** Neither has a free, ToS-compliant
  API for automated trend/content discovery in 2026 — scraping either would
  carry the same legal/ToS risk this project specifically moved away from
  with Reddit. Aesthetic "hidden gems" instead come from real, licensed
  stock footage (Pexels/Pixabay) matched against topics sourced from open
  publisher feeds, Mastodon, and Lemmy.
- **Actual Dota 2/CS2/tournament gameplay or broadcast clips are not used.**
  EWC, TI, and pro-player streams are copyrighted broadcast content owned by
  Valve/organizers/streamers — ripping and reposting them carries the exact
  copyright risk this project deliberately avoided for traditional sports.
  What IS wired in: esports-press RSS (Dexerto, Dot Esports, GamesRadar,
  Rock Paper Shotgun), so Gaming/Lore can cover Dota/CS2/tournament
  storylines, drama, and stats as narrated commentary over LICENSED stock
  gaming-adjacent b-roll — same successful pattern as the existing lore
  content, not a rights violation waiting to happen. If you have a specific
  licensing deal or your own recorded footage for a game, that's a separate,
  compliant path I'm happy to wire in.

## New: Food niche

Japanese, Korean, and global food content, sourced from real food-blog RSS
(Just One Cookbook, Maangchi, Serious Eats, Bon Appétit, Korean Bapsang).
Uses the existing licensed-footage + word-clip infrastructure — no new
agent needed.

## Video length discipline

Scripts target ~45s (word-clip mode: ~25-35s) specifically because YouTube
Shorts/TikTok virality both favor staying well under 60 seconds despite
platforms technically allowing longer. Agent 3 now logs a warning if a
render comes back over 58s so an overlong video never ships silently.

## Token efficiency

Trim-point calculation (a mechanical timing task, not creative writing) now
runs on `gpt-4o-mini` instead of `gpt-4o` — a real cost reduction with no
quality tradeoff that matters for that specific task. Script/title writing,
where reasoning quality actually matters, stays on `gpt-4o`.

## Dashboard features

- Per-niche run buttons + full-loop button
- Cost tracker (OpenAI/ElevenLabs/Shotstack spend estimate, per-niche breakdown)
- Retry button on failed jobs, with the error shown inline
- **Published Videos widget** — thumbnail grid of everything that's actually
  gone live on YouTube, linking straight to each video
- **🔥 Check What's Trending** — the ad-hoc trend explorer described above
- Script/title editor with the title-engineering reasoning shown inline (see
  next section)

## News niche & word-clip format

The News niche renders **giant single-word/short-phrase captions** (a
"word-clip" style) instead of the usual 2-3 word active captions — set via
`wordClipMode: true` in that niche's `editing_style_preset`. Script length
shifts to short punchy phrases (45-65 words) rather than flowing narration.
Any niche can opt into this style the same way.

## Language support

Niches have a `language` column (default `en`). Setting it to `hi` makes
Agent 2 write the script, title, and description in Hindi — no separate
voice IDs needed, since ElevenLabs' `eleven_multilingual_v2` model
auto-detects language from the script text. See the commented example in
`supabase/migration_news_niche.sql` for creating a Hindi variant of any niche.

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

## Cost tracker & retry (dashboard)

The right-hand column now shows an **approximate spend tracker** — running
totals of OpenAI tokens, ElevenLabs characters, and Shotstack render seconds
across every job, converted to a rough dollar estimate, broken down per
niche. These are *estimates only* based on approximate per-unit rates
hardcoded in `src/index.js` (`RATES` constant) — check each provider's own
dashboard for real billing, especially since Shotstack/ElevenLabs pricing
varies by plan tier.

Any job that lands on **Failed** now shows a **↻ Retry this niche** button
directly in the pipeline queue — click it to kick off a fresh run for the
same niche without re-triggering the whole loop. The failed job's error
message is also shown inline so you can see why it failed before retrying
(e.g. insufficient footage, a Shotstack timeout, a malformed script).

**Migration note:** if your Supabase project was set up before this update,
run the migration block at the bottom of `supabase/schema.sql` once (it's
`alter table ... add column if not exists`, safe to re-run) to add the
`openai_tokens`, `elevenlabs_characters`, and `shotstack_render_seconds`
columns the cost tracker depends on.

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

## Multi-channel routing

If you eventually run separate YouTube channels for different content types
(e.g. one for Gaming, one for Food), set `GOOGLE_CHANNELS` in `.env` as a
JSON map of channel key → refresh token:
```
GOOGLE_CHANNELS={"gaming":"1//0abc...","food":"1//0xyz..."}
```
Get each channel's refresh token the same way as the primary one
(`npm run auth:youtube`, signed into that channel's Google account). The
dashboard's **Channel Routing** panel lets you assign any niche to any
configured channel with a dropdown — no redeploy needed, it's a live
Supabase update. Niches left on "primary" use `GOOGLE_REFRESH_TOKEN` as
before; single-channel setups need zero extra configuration.

## New: Viral / Memes niche

Sourced from real trend signals (KnowYourMeme's RSS feed, Mastodon meme
tags, Lemmy, Google Trends) — turned into **original narrated commentary**
over licensed stock footage or word-clip text visuals. It deliberately
never re-embeds someone else's clip, screenshot, or meme image — that's
what keeps this niche legally clean while still riding real cultural
moments. Word-clip mode by default, 20-35s target length.

## Honest answer: can Pexels/Pixabay cover everything?

Mostly, for lifestyle/nature/generic b-roll — which is most of what
Aesthetic, Psychology, Travel, Food, and News actually need. Where they
genuinely can't help: specific game footage (there's no "Dota 2 gameplay"
stock category) or anything requiring a recognizable real person/branded
scene. For gaming/esports content, the honest workaround already in use is
narrating over thematically-matched generic stock (dark fantasy landscapes,
neon gaming-setup shots, cheering-crowd/stadium footage — all real,
licensed Pexels/Pixabay categories) rather than needing the actual game
footage. If you later want more specific visuals, the compliant upgrade
paths are a paid stock library (Storyblocks/Artgrid) or an AI video-
generation API (Runway/Pika) — neither is wired in today, flagging them
here as legitimate future options rather than pretending Pexels/Pixabay
covers everything.

## Performance feedback loop

Every 6 hours, `src/lib/performanceTracker.js` pulls real view/like/comment
counts (via `videos.list?part=statistics` — cheap, no separate Analytics
API needed) for any video that's been live at least 6 hours, and
`recalibrateFromPerformance` in `trendScoring.js` nudges source-reliability
weights based on which sources' picks actually performed well. This is
real ground-truth feedback, not just harvest-time corroboration — see that
file's header comment for exactly what this does and doesn't yet cover.

## Recommended first videos

For your first few renders, prioritize niches where compliant stock footage
is strongest and the content itself is least experimental — you want the
first impression to be clean production, not a stress-test of every new
feature at once:

1. **Aesthetic** — cinematic stock footage is abundant and gorgeous;
   nothing to get legally cautious about; good visual proof of quality.
2. **Food** — same strength (real food-blog RSS, strong stock footage
   categories), plus it's a genuinely underserved Shorts niche right now.
3. **Gaming/Lore** (Elden Ring or Warhammer 40k) — slightly more ambitious
   (lore-grounding + longer-form option), good second/third test once
   you've confirmed the pipeline end-to-end on the simpler niches above.

Hold off on News and Viral for your very first batch — both lean more on
fast-moving, less-curated sources and are worth watching closely with
Autopilot off before trusting them unattended.

