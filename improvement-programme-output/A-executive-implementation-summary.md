# UNity Platform Improvement Programme — Executive Implementation Summary

**Branch:** `platform-improvement-programme`, based on `e49-2-admin-performance` at `f209ff7`.
**Commits this programme:** 6 (`08ec8e4` → `74e9eda`), all uncommitted-to-`main` pending your review.
**Nothing was pushed or deployed.** Nothing was merged. No live Supabase/Vercel/GA4/Meta dashboard was accessed (none of these tools give me that access) — every item requiring it is explicitly flagged, not guessed at or faked.

## What was implemented and verified (code-level, tested, built, in this repo)

1. **Search: location and availability filters are now real.** The audit found `ListingFilters.location` was declared but never read, and there was no date-range/availability filter at all. Both are now wired end-to-end: a new migration extends `search_listings` with province/city/date-range parameters (reusing `create_booking_request`'s own overlap-check logic, never a new convention), the data layer and UI (province dropdown, city input, a date-range picker matching the existing booking-flow's own picker) are wired through, and `minPrice` — which had the identical bug — was fixed alongside it.
2. **Analytics: the taxonomy now covers payment through payout.** The audit found the 16-event system went dark after booking/order creation — no payment outcome, handover, return, refund, dispute, or payout events existed. Six new events were added, following the existing architecture's own pattern exactly (DB allowlist + strict Zod schema + service-role-only write), and instrumented at the 6 real call sites where each outcome becomes authoritative.
3. **A cookie-consent banner now exists and actually gates tracking.** Previously `trackEvent()` fired unconditionally from first page load, despite the banner being a documented-but-unbuilt requirement. It's now a single gate (`hasAnalyticsConsent()`) that every client-side event passes through, with a banner shown once per browser and a "Cookie Preferences" footer link to change the choice later. Verified end-to-end in a real browser (shows, hides after a choice, stays hidden on reload, reopens via the footer link).
4. **Two unbounded-growth log tables now have a working retention mechanism.** `analytics_events` already had a cleanup RPC that was never scheduled; `email_deliveries` had neither. Both now have the mechanism and a ready-to-call route, copying the exact pattern `ad_impressions`/`ad_clicks` already use successfully.
5. **`orders` and `payments` now have a `created_at` index**, matching what `bookings`/`ledger_entries` already had.
6. **Admin reads of KYC documents are now logged, not just admin mutations.** A new access-log table (matching the existing `admin_message_access_log` pattern exactly) records every genuine document reveal, unified into the same admin audit feed as approve/reject actions.
7. **A disaster-recovery runbook now exists** (`docs/operations/DISASTER_RECOVERY_RUNBOOK.md`) — procedures for 5 real-world scenarios, with every RTO/RPO figure explicitly marked as a proposal pending live verification, never presented as a proven capability.
8. **Carried in from the immediately preceding work on this same branch base:** the `cancel_booking` concurrency-race fix and the admin-performance N+1 query fix (both already covered by their own prior reports) remain part of this branch's history.

Every item above was typechecked, linted, built, and covered by new or existing automated tests after each batch — see Doc E for the exact numbers.

## What remains incomplete (by scope, not by failure)

This brief's 28 sections describe a multi-week programme; a single session covered the parts that are genuinely code-only and didn't require credentials, accounts, or legal sign-off I don't have access to. Explicitly **not attempted** this session, and why:

- **Admin MFA enforcement (Phase 1 item 4).** Not built. Enforcing MFA on existing admin accounts without a safe enrollment/rollout path risks locking out real administrators — exactly the risk this brief's own instructions flagged. This needs a deliberate, supervised rollout (enroll admins first, confirm enrollment, then flip enforcement), not a same-session code change.
- **Malware-scanning integration (Phase 1 item 6).** Not built. Any real scanner needs a vendor account and API credentials I don't have. Building a fail-safe integration *boundary* with no real scanner behind it would just be dead code pretending to be a control — I did not do that.
- **Error monitoring / Sentry (Phase 1 item 7).** Not built, for the same reason — a Sentry integration with no real DSN is inert, and adding the dependency without a working destination doesn't move the needle on "are failures observable."
- **Search scalability measurement at 1k/10k/100k listings (Phase 2 item 11).** The test script exists and is ready (`scripts/search-scale-test.mjs`) but was deliberately **not run** — it would insert up to 100,000 synthetic rows into the one shared Supabase project this engagement has used throughout (there is no separate staging project), which crosses the same live-write-authorization line every other live-data decision in this engagement has required explicit sign-off for.
- **GA4/Meta/Search Console review (Phase 3 item 12 header).** None of these exist in this codebase (confirmed by the preceding audit) — there is nothing to inspect or improve. The analytics work that *was* possible (extending the first-party taxonomy, building the consent gate) is done.
- **Actual backup/region verification and a real restore test (Phase 4 items 17-18).** Cannot be done without Supabase dashboard access. The runbook captures the procedure; it cannot capture a fact I can't observe.
- **Database query/connection-pool performance review beyond the two indexes added (Phase 5 item 19), broader platform-reliability review (item 20), and infra cost/capacity assessment (item 22).** Not done this session — the prior admin-performance work (N+1 query fan-out fix) already covered the one concrete, measured performance defect this engagement had found; a speculative broader pass without a specific finding to chase would have been exactly the kind of unguided work this brief's own "measure first" instruction (echoed from the preceding performance investigation) warns against.

## What requires production authorization before it could ever ship

- Merging this branch to `main` (not requested, not done).
- Scheduling the two new cron routes — the one line each needs in `vercel.json` was deliberately not added, since that file is a standing parked file in this project that must not be edited without your explicit approval.
- Any of the "not attempted" items above, once the relevant credentials/accounts/legal review exist.

## What requires external consultants or providers

- A malware-scanning service (ClamAV-as-a-service, a cloud AV API, or similar) for Phase 1 item 6.
- Sentry or an equivalent APM/error-monitoring provider for Phase 1 item 7.
- South African legal/privacy counsel to review the consent-banner copy (currently placeholder English) and confirm whether the technical consent gate satisfies POPIA on its own or needs a server-recorded receipt too.
- Whoever holds Supabase/Vercel dashboard access, for every item in the "requires production authorization" and "backup/region verification" categories above.

See Doc F for the full, re-verified four-pillar scorecard; Doc G for launch readiness per pillar.
