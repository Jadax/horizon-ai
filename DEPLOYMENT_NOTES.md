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
