## Active Rules
- Keep scripts modular; do not duplicate helper functions — reuse existing lib/pipeline code.
- Never write extensive explanatory text in responses; output code/diffs directly, keep prose to 1-3 lines.
- Supabase: one file only — `supabase/COMPLETE_SETUP.sql`. Never create separate migration files.
- Every commit: bump `package.json` version (semver), write a short commit summary, then `git push` automatically (`GIT_TERMINAL_PROMPT=0 git push origin master`) — no confirmation needed.
- No new paid API/service dependencies without asking first.
- No YouTube/Twitch/Kick scraping or downloading — no official download API exists for any of them, even to the owner. Vimeo/CC-licensed/manual upload only.
