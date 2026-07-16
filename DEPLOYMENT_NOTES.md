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
