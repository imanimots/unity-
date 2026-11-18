# Next Implementation Priorities (dependency-ordered)

| # | Task | Owner | Priority | Blocker status | Acceptance criteria |
|---|---|---|---|---|---|
| 1 | Get Supabase dashboard access; confirm region, backup frequency, PITR status | Technical Coordinator / founder | P0 | **No blocker — just needs someone to log in and check** | A written record of all three facts, dated |
| 2 | Perform one real test restore to a non-production project, using what #1 revealed | Technical Coordinator + DB specialist | P0 | Depends on #1 | Restore completes; time-to-restore recorded; data integrity spot-checked |
| 3 | Legal review of consent-banner copy + POPIA server-receipt question + retention periods | Legal/privacy adviser | P0 | **No blocker — needs scheduling** | Signed-off copy and a definite answer on server-side consent recording |
| 4 | Schedule the two new retention-job cron routes in `vercel.json` | Whoever owns that file | P1 | **No blocker — one line each, needs your approval to edit a parked file** | Both jobs visible in Vercel's cron dashboard, firing on schedule |
| 5 | Design and execute a supervised admin-MFA enrollment rollout | Security engineer + Supabase Auth access | P0 | Needs Supabase dashboard access (same as #1) | Every current admin has a verified factor enrolled BEFORE enforcement is flipped on; a non-enrolled admin cannot be locked out by surprise |
| 6 | Select and provision a malware-scanning vendor; build the integration | Security engineer | P1 | Needs a vendor account/credentials | A test file with a known AV test signature (EICAR) is blocked before storage |
| 7 | Select and provision Sentry (or equivalent); wire basic instrumentation | Platform engineer | P0 | Needs a vendor account | A deliberately-triggered server error appears in the monitoring dashboard within minutes |
| 8 | Live browser verification of the new search filter UI (province/city/date-range) | Developer | P2 | None | Click-through confirms filters apply correctly, combine correctly, and clear correctly |
| 9 | Authorize and run `scripts/search-scale-test.mjs` at 1k, then 10k, then 100k | Founder/Technical Coordinator approval, then developer | P2 | Needs explicit sign-off to write synthetic data at volume | Latency numbers recorded at each scale; decide whether Postgres FTS remains sufficient |
| 10 | Field-level encryption for national ID/passport numbers, matching the existing Vault treatment of bank account numbers | DB engineer | P1 | None | ID number stored via `vault.create_secret`, not plaintext, with a migration plan for existing rows |
| 11 | Document a definite, legally-reviewed data-retention period per category, then adjust the two retention jobs' intervals (currently 365/180-day reasonable defaults) to match | Legal + developer | P1 | Depends on #3 | Retention intervals in code match the signed-off policy exactly |
| 12 | Write a committed authenticated E2E test for the merchant role (confirmed gap from the preceding E49.1 phase, unrelated to this programme's own scope but still open) | Developer | P2 | None | A Playwright spec covering merchant login/dashboard/listings passes reliably |

**Items 1, 3, 4, and 7 have no technical blocker at all** — they're waiting on access, scheduling, or a vendor decision, not on more engineering work. If this list has one message, it's that: the next-most-valuable thing is rarely "write more code" right now — it's closing the facts nobody has checked yet.
