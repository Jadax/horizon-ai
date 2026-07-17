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

### Social-feed sourcing and quality gates

Run [`supabase/migration_social_quality.sql`](supabase/migration_social_quality.sql) once to enable per-niche `social_rss_feeds`. YouTube supports native public channel Atom feeds. Twitch, X/Twitter, and Kick do not offer a reliable native public channel RSS feed, so Horizon accepts public RSS exports or feeds you are explicitly authorised to access; it does not scrape pages, copy videos, or bypass logins/paywalls.

Set feeds with `PATCH /api/niches/:name` using `{"social_rss_feeds":[{"platform":"youtube","label":"Creator","url":"https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID"}]}`. For an authorised protected feed, add its request headers to `SOCIAL_RSS_HEADERS` and reference its key with `auth_key`; never store a token in Supabase.

The creation path now writes an ordered visual plan before sourcing b-roll. Each stock search is tied to an exact script line and carries that semantic cue into the cut list. This is the quality gate that prevents unrelated “pretty” filler clips. Music tracks can now be tagged with `mood_tags`, `bpm`, and `instrumental`, letting the per-topic format decision choose the closest track rather than randomly selecting within an energy bucket.

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



---

# DEPLOYMENT NOTES — MythosVibe / Horizon AI on Railway

Working reference for this specific deployment. Keep this file updated as
the setup evolves — it's the fastest way to get a second machine or a future
session back up to speed.

## Current setup

- **Channel:** MythosVibe (@MythosVibeHQ) — UCbLPcl6mW7z0-LNia_RKUSg
- **Host:** Railway, service `horizon-ai`
- **Domain:** horizon-ai-production-284f.up.railway.app
- **Code:** GitHub (private repo), deployed via GitHub Desktop → push → Railway auto-deploy
- **Local dev copy:** `C:\Dev\horizon-ai` (NOT the Drive folder — see below)
- **Drive master copy:** `G:\My Drive\MythosVibe\horizon-ai` (source of truth for code,
  do not `npm install` here)

## Why two folders

Google Drive's desktop sync cannot reliably handle `node_modules` (tens of
thousands of small files) — early `npm install` attempts inside the Drive
folder produced corrupted tarball errors. Fix: keep the Drive copy as the
synced master for code + `.env`, but always run `npm install` / `npm start`
from the local `C:\Dev\horizon-ai` copy. Copy code changes between the two
manually, or treat Git as the sync mechanism instead of Drive once things
stabilize.

## Railway build gotcha: builder is Railpack, not Nixpacks

Railway's current builder for this project is **Railpack** (visible in build
logs as `using build driver railpack-v0.31.1`), not the older Nixpacks. This
matters because:
- `.nvmrc` — **ignored** by Railpack
- `nixpacks.toml` — **ignored** by Railpack
- `NIXPACKS_NODE_VERSION` env var — **ignored** by Railpack

**What actually works:** Railpack reads the Node version straight from
`package.json`'s `engines.node` field. Confirmed fix:
```json
"engines": { "node": ">=22.0.0" }
```
This was required because `@supabase/supabase-js`'s realtime client needs
native WebSocket support, only available in Node 22+. Node 18/20 crash on
boot with `Error: Node.js detected but native WebSocket not found`.

If Railway ever switches builders again, check the top of the build log for
`using build driver ...` before assuming any of the above config files apply.

## OAuth / YouTube auth notes

- Refresh tokens are **not tied to the redirect URI** — a token generated via
  `npm run auth:youtube` locally (against `localhost:8080/oauth2callback`)
  continues to work fine when pasted into Railway's `GOOGLE_REFRESH_TOKEN`,
  even though Railway's actual redirect URI is different. No need to redo the
  OAuth consent flow after deploying, only if the token is later revoked.
- Google Cloud Console's Authorized redirect URIs list should still include
  both the localhost one (for future local re-auth) and the Railway domain's
  `/oauth2callback` (for completeness, even if unused in the current flow).
- When approving the OAuth consent screen, select the **MythosVibe** brand
  account, not the personal Google account — this determines which channel
  uploads land on.

## Dashboard password / prompt() issue

Some browsers/extensions (uBlock Origin and similar) block native
JavaScript `prompt()` dialogs, which the dashboard originally used to ask
for `DASHBOARD_PASSWORD`. If the password prompt never appears and every API
call 401s, set it manually via browser DevTools console:
```js
localStorage.setItem("horizon_key", "YOUR_DASHBOARD_PASSWORD_VALUE");
location.reload();
```

## Shotstack environment

- `SHOTSTACK_ENV=stage` → sandbox, free, output is watermarked. Used in the
  **local** `.env` for testing pipeline logic without cost.
- `SHOTSTACK_ENV=v1` → production, no watermark, **requires a paid Shotstack
  plan**. Used on **Railway** for real MythosVibe uploads. Confirm the
  Shotstack account is actually upgraded before relying on this — v1 calls
  fail outright on a free-tier account rather than silently falling back.

## Pexels signup issue (as of this deployment)

Pexels' "Generate API Key" flow was returning "API Key generation is
experiencing issues, please try again later" repeatedly — appears to be an
outage on Pexels' side, not an account/form issue. Not a blocker: the
pipeline runs fine on Pixabay alone (Agent 1 treats both sources as
optional and merges whatever's available). Retry Pexels periodically; once
working, just add `PEXELS_API_KEY` to Railway's variables, no code changes
needed.

## Known-good checklist for a fresh machine

1. Install Node.js 22+ and Git
2. Clone the GitHub repo (not the Drive folder) into a local working dir
3. Copy `.env` from the Drive master copy into the local working dir
4. `npm install`
5. `npm start` to test locally, or just rely on the Railway deployment —
   local running is optional once Railway is confirmed stable

## Changelog

- **Declined an n8n/Apify workflow scraping Instagram Reels and TikTok**
  to "reverse-engineer" specific real creators' videos into clone
  blueprints (submitted as a JSON workflow file + a "Creative Director"
  persona prompt + a demo GIF using recognizable copyrighted TV footage as
  an example). Same category as the Apify/Nitter/Reddit-scraper asks
  declined earlier — downloading a specific real video without
  authorization and generating a blueprint meant to functionally
  reproduce it is a sharper problem than general trend-following, not a
  new category exempted by "reverse-engineering" framing. Not built.
  **Adopted from the same source, separately:** the "No Random Filler"
  principle — every visual should match what the script is literally
  saying at that moment, not just the niche's general mood.
  `TRIM_SYSTEM` in `agent2_scriptwriter.js` now requires line-level
  semantic alignment (which specific phrase each cut illustrates) instead
  of just emotional-arc-level footage ordering, applied to our existing
  compliant Pexels/Pixabay pipeline — same idea, none of the scraping.

- **Consolidated all 14 migration files into `supabase/COMPLETE_SETUP.sql`.**
  Every prior migration (schema.sql through migration_feed_library.sql) is
  now concatenated into one ordered, idempotent script — run this one file
  instead of 14 separate ones for both fresh setups and catching up an
  existing project. The individual files are kept in the folder as a
  changelog/reference (each one's header comment still explains what it
  added and why), but `COMPLETE_SETUP.sql` is the one to actually execute
  going forward. Since every statement uses `if not exists` / `on conflict
  do nothing` / `on conflict do update`, running it more than once is safe.

- **Voice/hook/pacing tuning + declined Twitter/TikTok scraping-bridge
  request (same category as the earlier Apify decline).**
  - Declined again: "alternative open-source viewer frontends" and "open
    scraping bridges" for Twitter/X and TikTok (i.e. Nitter-style proxies)
    — these scrape platforms without authorization, exist in a legal gray
    zone, and get blocked/DMCA'd regularly; wiring one in would just
    import that instability directly into the pipeline. Not built.
  - **ElevenLabs voice settings tuned** to specific natural-speech ranges:
    stability 0.63 (was 0.5 — avoids both cold monotony and warble),
    similarity_boost/clarity 0.82 (was 0.75), style exaggeration 0.20 (was
    0.35, now in the 15-25% "natural syllable stress" band rather than
    over-dramatic).
  - **Hook timing made explicit**: line 1 must land within 2.5 seconds of
    spoken audio, greetings/generic intros explicitly forbidden (not just
    implied by "no throat-clearing").
  - **Colons banned alongside dashes** — same "reads as written, not
    spoken" problem.
  - **Visual cut pacing tightened dramatically**: fast-cut styles now
    target 1.5-2.5s per clip (was 4-8s) to match actual high-retention
    short-form pacing; slow/meditative styles stay at 3-5s (was 6-10s),
    intentionally slower since that pace fits calm content. Also fixed a
    real bug this surfaced: the trim-validation clamp enforced a hidden
    3-second minimum per cut, which would have silently overridden the new
    faster pacing — lowered to 1.2s to actually match the new target.
  - **Niche Management panel extended** with a language (EN/HI) toggle
    alongside the existing channel-routing dropdown, editable live from
    the dashboard without touching Supabase directly.

- **"No AI-tell" hardening: total em-dash ban + banned-word sanitizer.**
  The script prompt previously only forbade em-dashes jammed against words
  with no space (a caption-sync bug fix); now bans them entirely, plus a
  list of words that read as obviously AI-generated ("delve", "testament",
  "moreover", "tapestry", "boasts", "landscape" used metaphorically, "dive
  into", "it's worth noting", etc.). A new post-processing safety net in
  `agent2_scriptwriter.js` (`sanitizeText`) runs on every script/title/
  description regardless of whether the prompt worked: strips any em/en-
  dash that slipped through and logs a warning listing any banned word
  that made it past the prompt, so you can see how often correction is
  actually needed rather than assuming the prompt alone is sufficient.

- **Cost, quality, and two new niches (this session).**
  - **Fixed a real caption/spacing bug**: ElevenLabs word-timing alignment
    only treated whitespace as a word boundary. When GPT wrote an em-dash
    or en-dash directly between two words with no space (e.g.
    "growth—no matter"), those two words merged into one caption token
    with no visible space. Fixed in `agent3_audio.js` by also treating
    em/en-dashes as boundaries, AND fixed at the source — the script
    prompt now explicitly forbids dashes without surrounding spaces.
  - **Script tone rewritten for natural, casual delivery** — explicit
    "read it out loud, if it sounds stiff rewrite it looser" instruction,
    contractions encouraged, avoids press-release phrasing.
  - **Added a "second hook" requirement at ~5-6 seconds** (word 12-14 at
    natural pace) — short-form retention has a second steep drop-off right
    around there, not just at the very start; the script prompt now
    requires a concrete beat (a number, reveal, or reframe) to land at
    that mark specifically, not just a strong opening line.
  - **Viral niche duration tightened to a strict 20-30s** per direct
    instruction that viral-length content needs to be short, not just
    "short-ish."
  - **Format Decision Engine now also picks per-topic music energy**
    (High/Suspense/Chill/Wonder), not just word-clip mode/duration/footage
    mood — a somber topic in an otherwise upbeat niche now gets music that
    actually matches its register instead of the niche's static default.
  - **Cost investigation**: a $1.77 render was reported. Diagnostics
    confirmed Railway was actually running `SHOTSTACK_ENV=stage` (free,
    watermarked sandbox) at the time — meaning Shotstack itself very
    likely charged nothing, and the real cost was OpenAI + ElevenLabs at
    their actual current per-unit pricing, which is probably higher than
    this project's rough `RATES` estimate constants. The cost tracker's
    header comment now says this explicitly rather than implying the
    numbers are precise — check platform.openai.com/usage and ElevenLabs'
    billing page for ground truth, and update `RATES` in `routes/costs.js`
    to match once known.
  - **New: "Render Production" feature** — solves the deeper cost problem
    properly. Previously the only way to get a non-watermarked video was
    setting `SHOTSTACK_ENV=v1` globally, meaning EVERY render (including
    daily test runs) would cost real Shotstack money. Now: day-to-day runs
    stay on free `stage`, and a new **"🎬 Render Production"** button in
    the dashboard re-renders only the specific job you've approved at full
    v1 quality — reusing the already-generated script, trim points,
    voiceover, and music (no OpenAI/ElevenLabs re-call), so it costs only
    one Shotstack render, only for videos actually worth paying for.
    Requires `pipeline_logs.voiceover_words` / `duration_seconds` /
    `music_track_url` / `preset_snapshot` (new columns, saved automatically
    going forward) to be present on a job, so this only works for jobs run
    after this update.
  - **New niche: News India** — dedicated to Indian news specifically
    (India Today, ABP Live, Times of India, NDTV, Hindustan Times),
    `trend_region: 'IN'` so Google Trends/YouTube Trending pull India-
    specific data instead of defaulting to US, strict 20-30s word-clip
    format, English by default (can flip `language` to `'hi'` later).
  - **New niche: Mindful/Calm** — deliberately distinct from the existing
    analytical "Psychology" niche: feel-good, meditative, gentle-pacing
    content ("breathe with me," "put your phone down for 20 seconds").
    word_clip_mode off by default, slow cross-dissolve, chill music, softer
    25-45s range, sourced from mindful.org, Tiny Buddha, and
    PositivePsychology.com RSS feeds.
  - **Git workflow recommendation**: commit after each meaningful change
    with a short, specific message (what changed + why in one line) rather
    than large infrequent commits — makes it much easier to find which
    change introduced a bug later, and this changelog can then just point
    at commit messages instead of re-explaining everything here.

- **Comprehensive workflow expansion: multi-channel routing, flexible
  duration, Viral niche, performance feedback loop.**
  - `target_channel` added to `niche_configurations` + `pipeline_logs`.
    `GOOGLE_CHANNELS` env var (JSON map of channel key → refresh token)
    lets different niches upload to different YouTube channels — set once
    per additional channel, then reassign any niche to it from the
    dashboard's new **Channel Routing** panel (no redeploy needed).
  - `target_duration_min_seconds` / `target_duration_max_seconds` per
    niche replace the old fixed ~45s target. Most niches stay TikTok/
    Shorts length; Gaming/Lore (up to 90s) and Food (up to 75s) can run
    longer when a topic genuinely needs it. Agent 2's loop mechanic
    auto-disables past ~70s since it's a short-form retention trick, not
    something that fits a 2-minute video.
  - `lore_wiki_apis` generalizes the old hardcoded Elden Ring wiki lookup
    to a configurable list per niche. Gaming/Lore now also pulls from
    Lexicanum (Warhammer 40k's real MediaWiki-powered fan wiki) alongside
    Elden Ring's wiki.gg, plus Warhammer Community's official RSS feed.
  - **New Viral/Memes niche** — sourced from KnowYourMeme's RSS feed,
    Mastodon meme tags, Lemmy, and Google Trends, turned into ORIGINAL
    narrated commentary over licensed stock or word-clip visuals. This
    niche deliberately never re-embeds someone else's clip, screenshot, or
    meme image — same compliance principle as every other niche here.
  - **Performance feedback loop** (`src/lib/performanceTracker.js` +
    `recalibrateFromPerformance` in `trendScoring.js`) — a 6-hourly cron
    now pulls real YouTube view/like/comment counts for published videos
    (via the cheap `videos.list?part=statistics` call, no separate
    Analytics API needed) and nudges the trend engine's source-reliability
    weights based on ACTUAL performance, not just harvest-time
    corroboration. This closes part of the "future step" gap flagged in
    the original trend-scoring changelog entry below.
  - Author metadata added: `package.json`'s `author` field and every
    uploaded video's description now credit "Tushant Sharma" / "A
    MythosVibe production."
  - **Explicitly declined and NOT built, on request**: (1) deliberately
    scraping sources in violation of their ToS, and (2) ripping/reposting
    influencer or tournament gameplay clips from YouTube/Kick/Twitch. Both
    were requested directly in this session; both carry real copyright/ToS
    risk regardless of a clip's popularity or platform, and building either
    would undermine the compliance work already done to move this project
    off Reddit's aggressive lockdown. See the README's "What's NOT wired
    in, and why" section for the full reasoning and the compliant
    alternatives built instead (esports-press RSS narrated over licensed
    stock, rather than actual gameplay/broadcast clips).

- **Major restructuring: code split into src/sources/, src/lib/, src/routes/.**
  `agent1_harvester.js` and `index.js` had grown into large monoliths as
  features accumulated. Harvesting integrations moved to one small file
  each under `src/sources/` (rss.js, googleTrends.js, gdelt.js,
  youtubeTrending.js, fediverse.js, reddit.js); the trend-scoring logic
  moved to `src/lib/trendScoring.js`; and `index.js`'s routes split into
  `src/routes/jobs.js`, `run.js`, `trending.js`, `costs.js`. `index.js`
  itself dropped from ~245 lines to ~65 — now just auth, the SSE stream,
  cron, and mounting the route modules. Adding a new harvesting source or
  route going forward means adding one small file, not editing a monolith.
- **Trend-scoring engine added** (`src/lib/trendScoring.js`) — replaces the
  old ad-hoc "sort by engagement score" logic with a real scoring model:
  cross-source corroboration (same story appearing across multiple
  independent sources = likely rising, not yet peaked), freshness decay,
  specificity, and per-source reliability weights that self-adjust over
  time and persist in a new `trend_rules` table. See the header comment in
  that file for exactly what "self-updating" means today vs. the future
  step (closing the loop against real YouTube Analytics performance data).
- **Massively expanded harvesting sources.** Added: GDELT (global news
  dataset), Google News RSS, YouTube Trending (reuses existing upload
  OAuth), Mastodon hashtags, and Lemmy communities — all free, no-auth,
  genuine "hidden gem" sources most pipelines never touch. Every existing
  niche's RSS feed list roughly tripled (see
  `migration_harvesting_expansion.sql`), and **India-focused sources**
  (Times of India, NDTV, Hindustan Times) were added to News — India is the
  single largest Shorts-consuming market and was previously unaddressed.
- **Food niche added** (Japanese, Korean, global) — Just One Cookbook,
  Maangchi, Serious Eats, Bon Appétit, Korean Bapsang RSS feeds.
- **Ad-hoc trend explorer** — dashboard's 🔥 "Check What's Trending" button
  hits the new `/api/trending` route, which runs the same harvesting
  sources and returns the full ranked candidate list without running the
  rest of the pipeline (zero OpenAI/ElevenLabs/Shotstack cost).
- **Published Videos widget** — thumbnail grid on the dashboard showing
  everything that's actually gone live on YouTube, linking directly to
  each video (`/api/jobs/published`).
- **Token efficiency: trim-point calculation moved to gpt-4o-mini.** That
  step is mechanical timing/ordering, not creative writing — no quality
  tradeoff that matters, real cost reduction. Script/title writing stays on
  gpt-4o where reasoning quality matters.
- **Shorts-length safety net** — Agent 3 now logs a warning if a voiceover
  comes back over 58s, since virality for both YouTube Shorts and TikTok
  strongly favors staying well under 60s regardless of what the platforms
  technically allow.
- **Honest scope boundaries documented** (see README's "What's NOT wired
  in" section): Instagram/TikTok scraping and actual esports
  broadcast/gameplay clip ripping (Dota 2/CS2/EWC/TI) are deliberately not
  implemented — no free, ToS-compliant path exists for either, and both
  would reintroduce the exact copyright/ToS risk this project moved away
  from with Reddit. Esports content is instead covered via press RSS
  (Dexerto, Dot Esports, etc.) narrated over licensed stock footage — same
  pattern as the existing Gaming/Lore content.

- **Per-niche run buttons** added to the dashboard (below the header) —
  trigger Gaming/Lore, Aesthetic, Psychology, or Travel individually via
  the existing `/api/run/:niche` route, instead of only "run everything."
- **Cost tracker** panel added — approximate running spend across OpenAI,
  ElevenLabs, and Shotstack, per-niche breakdown. Requires the
  `openai_tokens` / `elevenlabs_characters` / `shotstack_render_seconds`
  columns — run the migration block in `supabase/schema.sql` once if the
  Supabase project predates this change.
- **Retry button** on Failed jobs — one click re-runs the pipeline for that
  job's niche via a new `/api/jobs/:id/retry` route, no need to hunt down
  which niche failed and re-trigger manually.
- **Fixed slash-in-niche-name routing bug** — "Gaming/Lore" broke the old
  `/api/run/:niche` URL-param route because of the literal `/`. Added
  `/api/run-niche` (POST body instead of URL param) which the dashboard now
  uses for all niche buttons; the old URL-param route is kept for
  backwards compatibility with niches that don't contain a slash.
- **Fixed Supabase 500s** — root cause was two separate misconfigurations:
  (1) `SUPABASE_URL` had accidentally been set to the full REST endpoint
  (`.../rest/v1/`) instead of the bare project URL, and (2) the Supabase
  project's `service_role` role was missing table grants (Supabase's new
  `sb_secret_...` key type doesn't automatically bypass RLS the way the
  legacy JWT `service_role` key does — switched to the legacy key from
  Settings → API Keys → "Legacy anon, service_role API keys" tab, and ran
  explicit `GRANT` statements for `service_role` on all three tables).
- **Reddit topic-harvesting replaced with RSS feeds** — Reddit deprecated
  unauthenticated `.json` access entirely on May 28-30, 2026 (see
  "Reddit API deprecation" section below). Agent 1 now sources topics
  primarily from real publisher RSS feeds per niche (IGN, PC Gamer,
  Psychology Today, Lonely Planet, etc.) plus Google Trends' official
  public RSS feed, with Reddit kept only as a harmless best-effort bonus
  source. Run `supabase/migration_rss_feeds.sql` once to add the `rss_feeds`
  column and seed real feed URLs per niche.
- **Titling logic overhauled.** Agent 2's title generation used to just say
  "clickbaity title under 40 chars" — too vague to reliably produce titles
  that are both catchy AND actually about the video. The new system prompt
  makes the model work through an explicit process every time: (1) pull the
  single most concrete, specific fact/claim from the script itself — never a
  vague category; (2) pick one proven title pattern that genuinely fits that
  fact (curiosity gap, specific number/stakes, contrarian reframe, direct
  consequence, or insider callout naming something the audience already
  recognizes); (3) calibrate wording for a tech-savvy audience that already
  knows the niche's basics and will bounce off "you won't believe" style
  vagueness; (4) verify the title's claim actually appears in the script
  before finalizing — the script is never stretched to fit a punchier title,
  only the reverse. The model also returns a `title_reasoning` field (which
  hook it pulled, which pattern, why it fits) stored in `pipeline_logs` and
  shown in the dashboard's script editor, so you can spot-check the logic
  behind any title rather than just trusting the output blind. Run
  `supabase/migration_title_reasoning.sql` once for existing projects.
- **News niche + word-clip format added.** Catchy viral word-clip videos
  (giant single-word/short-phrase captions synced to voiceover) built from
  real breaking/trending news. New free, no-auth sources added to Agent 1:
    - **GDELT Project** (api.gdeltproject.org) — a genuinely underused,
      completely free global news dataset (backed by Google Jigsaw),
      updated every 15 minutes across ~100 languages. Used for the News
      niche specifically.
    - **Google News RSS** (news.google.com/rss) — free, no auth, official
      top-stories or topic-search feed. Also News-niche-specific.
    - **YouTube Trending** (`videos.list?chart=mostPopular`) — reuses the
      existing upload OAuth credentials for a read-only call (~1 quota
      unit). Pulled for every niche as a "what's already working in
      vertical format" signal, not just News.
  `wordClipMode: true` in a niche's `editing_style_preset` switches Agent 4
  from the usual 2-3 word active captions to giant single-word cards
  (96px vs 34-46px), and Agent 2's script prompt shifts to short punchy
  phrases (45-65 words) instead of flowing narration. Run
  `supabase/migration_news_niche.sql` once to add the niche.
- **Optional Hindi support added.** A new `language` column on
  `niche_configurations` (default `'en'`) is read by Agent 2 to write the
  script (and title/description) in Hindi when set to `'hi'`. No new voice
  IDs needed — ElevenLabs' `eleven_multilingual_v2` model auto-detects
  language from the script text itself. See the commented-out example at
  the bottom of `migration_news_niche.sql` for creating a Hindi variant of
  any niche (e.g. `News (Hindi)`).

## Reddit API deprecation (May 2026) — why this mattered here

Reddit shut down unauthenticated `.json` endpoint access on May 28-30,
2026, breaking essentially every scraper and automation tool that relied
on the old "append `.json` to any Reddit URL" trick — which is what
Horizon AI's original Agent 1 design used. Self-service OAuth API
registration had already been closed since November 2025 under Reddit's
"Responsible Builder Policy"; the official API now requires manual
approval and costs $0.24 per 1,000 calls with a **$12,000/year minimum
commercial commitment** — not viable for a project this size.

This wasn't a bug in our code or account — it was an industry-wide,
simultaneous break affecting nearly every Reddit-dependent pipeline built
before mid-2026. The fix was to stop depending on Reddit as the primary
topic source and move to RSS feeds instead (see Changelog above), which
are free, unauthenticated, and considerably more stable long-term since
publishers have no equivalent incentive to lock down their own feeds.

If a specific RSS feed URL ever starts failing (publishers do occasionally
change their feed paths during a site redesign), the Live Status Stream
will show a "RSS feed failed" warning naming the exact URL — search
"<publisher name> RSS feed" to find the current one and update it via a
Supabase `UPDATE` on that niche's `rss_feeds` array.
