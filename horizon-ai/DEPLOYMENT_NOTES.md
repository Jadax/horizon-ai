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
