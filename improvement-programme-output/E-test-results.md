# Test Results

## Baseline (start of this programme, on `platform-improvement-programme` before any change)

| Check | Result |
|---|---|
| Typecheck | 0 errors |
| Lint | 0 errors, 19 pre-existing warnings |
| Build | Succeeds |
| Vitest | 4331/4334 passing, 3 known pre-existing failures (all tied to the parked Reviews V2 files, confirmed identical before and after every batch in this session) |

## Final (after all 6 commits this programme)

| Check | Result |
|---|---|
| Typecheck | 0 errors |
| Lint | 0 errors, 19 pre-existing warnings (unchanged) |
| Build | Succeeds |
| Vitest | 4365/4368 passing, same 3 known pre-existing failures |

## Regression comparison

**Net new: +34 passing tests, 0 new failures, 0 new lint/type errors.** The 3 known failures are byte-identical to the baseline — confirmed via the exact same file:test names before and after every batch.

| Batch | Tests before | Tests after | New tests |
|---|---|---|---|
| Search filters | 4331 | 4333 | +2 |
| Analytics taxonomy | 4333 | 4337 | +4 |
| Consent banner | 4337 | 4349 | +12 |
| Storage retention + indexes | 4349 | 4359 | +10 |
| Admin KYC access logging | 4359 | 4365 | +6 (net — see below) |

## A genuine bug found and fixed during this programme's own verification

While adding tests for the admin KYC document access logging batch, a vitest full-suite run showed 4 failures instead of the known 3. Investigated per this engagement's standing "never accept an anomalous reading without isolating it" discipline:

- **1 real bug, in my own new test**, not the application code: `fakeAdmin({ docRow: null })` used `opts.docRow ?? defaultValue`, and `null ?? x` evaluates to `x` in JavaScript — so the test meant to simulate "document not found" was silently getting the default "found" row instead, and the test assertion (`.rejects.toThrow(...)`) failed because the function correctly didn't throw. Fixed by checking `'docRow' in opts` instead of relying on nullish coalescing.
- **2 unrelated test files** (`src/lib/internal-cron/__tests__/auth.test.ts`, `src/app/api/affiliate/merchant-listings/__tests__/route.test.ts`) that appeared in the same anomalous run both passed cleanly in isolation on reconfirmation — classified as environmental flakes from concurrent test-suite load, consistent with this engagement's long-documented flakiness pattern, not a regression from anything touched this session.

This is reported here rather than quietly fixed and omitted, per this engagement's standing instruction to never claim success based only on a single run.

## Performance measurements

No new performance measurement work was done this session beyond what the immediately preceding admin-performance investigation already produced (N+1 query fan-out fix, 5-run stability confirmation at 19.7-27.8s, already reported separately). The search-scalability test script (`scripts/search-scale-test.mjs`) is built but not run — see Doc A/C for why.

## Security verification evidence

- The new `admin_kyc_document_access_log` table's RLS was written to exactly match `admin_message_access_log`'s already-reviewed posture (admin-read policy, service-role-only insert, no update/delete policy) — not independently re-derived.
- The consent-gate change was verified to fail closed: no consent decision, a declined decision, and a stale/invalid stored record all resolve to "tracking disabled," confirmed by 4 dedicated tests plus the existing SSR-safety test.
- No secrets, credentials, or personal data appear in any new log/commit — confirmed via the same `git status`/diff review discipline used throughout this engagement before every commit.

## Restore-test results

**None. No restore test was performed.** This requires live Supabase dashboard/project access this session does not have. `docs/operations/DISASTER_RECOVERY_RUNBOOK.md` §8 names this explicitly as unverified — it is not omitted or implied to have happened.

## Known limitations of this test pass

- The two new retention-job routes (`purge-events`, `purge-deliveries`) are tested against a fake Supabase client, confirming the route's own auth/dispatch logic — they have never been run against the real `cleanup_analytics_events()`/`cleanup_email_deliveries()` RPCs on a live database.
- The search filter migration's SQL correctness was verified by careful manual review and by the TS-level test confirming the right parameters are passed to the RPC — it was not run against a live Postgres instance (consistent with this engagement's established "static verification accepted" precedent from the prior E49.1 phase), so the actual query plan/index usage at scale is unverified.
- End-to-end browser verification was performed only for the consent banner (the one UI-facing change with real user-visible behavior to check); the search filter UI (province/city/date-range controls) was verified via typecheck/lint/build/unit-test only, not a live browser click-through, given the time already invested this session.
