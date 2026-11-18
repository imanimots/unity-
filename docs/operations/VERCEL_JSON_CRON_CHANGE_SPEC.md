# `vercel.json` — Why It's Parked, and the Exact Change Needed

## Why this file is parked

`vercel.json` is one of six files that this project's standing policy designates as permanently parked, alongside `docs/PUBLIC_TEST_RUNBOOK.md`, `scripts/verify-reviews-v2.mjs`, `src/app/api/internal/reviews/process-deadlines/route.ts`, `src/lib/env/validate.ts`, and that route's own scheduler-config test. These files must never be edited, staged, or committed regardless of what any phase brief asks for, unless you explicitly approve it for that specific file — a standing instruction that has held across every phase of this engagement to date, specifically because they carry in-progress, unrelated Reviews V2 work that this programme's scope must not disturb or conflict with. This session did not ask to lift that restriction, and did not touch the file.

## Current content (read-only, confirmed)

```json
{
  "crons": [
    { "path": "/api/internal/advertising/purge-events", "schedule": "0 3 * * *" }
  ]
}
```

## Exact proposed change (prepared, not applied)

```json
{
  "crons": [
    { "path": "/api/internal/advertising/purge-events", "schedule": "0 3 * * *" },
    { "path": "/api/internal/analytics/purge-events", "schedule": "0 4 * * *" },
    { "path": "/api/internal/email/purge-deliveries", "schedule": "0 4 * * *" }
  ]
}
```

- Both new routes are offset to 04:00 (one hour after the existing advertising purge) rather than the same minute, avoiding simultaneous cold-start contention on serverless functions that otherwise have no reason to run at the exact same instant.
- Both routes already exist, are already tested, and already share the same `isAuthorizedCronRequest()` authority every other internal cron route uses (`src/lib/internal-cron/auth.ts`) — this is a pure configuration addition, no code change required alongside it.

## What happens once this is applied (for whoever applies it)

- Vercel will begin invoking both routes daily via `GET` with its own `CRON_SECRET`-bearer header, exactly like the existing advertising purge route already receives.
- `cleanup_analytics_events()` will begin deleting `analytics_events` rows older than 365 days; `cleanup_email_deliveries()` will begin deleting `email_deliveries` rows older than 180 days. Given this project's actual current data (23,109 `email_deliveries` rows observed this session, none older than this project's few months of existence), the first several months of scheduled runs would delete 0 rows — there is no retroactive data-loss risk from turning this on today.
- No other behavior changes. Nothing about this diff touches the existing advertising-purge cron entry.
