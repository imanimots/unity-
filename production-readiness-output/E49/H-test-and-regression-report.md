# H — Test and Regression Report

## Baseline comparison

| Check | Before this session (end of E47) | This session (final) |
|---|---|---|
| Typecheck | 0 errors | 0 errors |
| Lint | 0 errors, 19 pre-existing warnings | 0 errors, 19 pre-existing warnings (unchanged) |
| Build | Clean | Clean — **independently re-verified twice**, including once with a deliberately-unsafe environment combination to confirm the new guard actually throws, then once more clean to confirm the real state still builds |
| Vitest | 4372/4375 passing | **4380/4383 passing** (+8 new tests, all for the new environment-separation module) |
| Known pre-existing failures | 3 | Same 3, confirmed identical test names |

## New tests this session

8 tests in `src/lib/env/__tests__/environment-separation.test.ts`, covering every combination of production/non-production deployment against production/non-production-configured Supabase URLs, plus the "no production ref configured yet" no-op case explicitly.

## Live verification performed this session

| What | Result |
|---|---|
| `next build` with a deliberately unsafe environment combination | **Failed immediately**, exact intended error message |
| `next build`, clean state, immediately after | **Succeeded** |
| Admin MFA enrollment page (`/admin/security`), post-`next.config.ts`-change | Loads correctly, zero console errors, confirmed via a real authenticated admin session |
| Live, read-only trace of the 10 "real-eligible" listings to their owning accounts | Both merchants are `@unitytest.internal` QA accounts |
| Live, read-only scan of all 314 auth users for any email outside the known QA pattern | 11 found (2 `gmail.com`, 9 `unitytest.co.za`); **every booking/order/payment/listing touched by these 11 accounts is explicitly `is_test=true`** |

## End-to-end production-equivalent testing (Phase 8 of the brief)

**Not performed against a genuinely separate environment, because one doesn't exist.** The 18 journeys listed in the brief's §21 (registration through backup/recovery) remain covered only by this engagement's existing test suites run against the one, current project — the same tests already run repeatedly across the prior two programmes (authenticated-smoke, rls-negative-access, route-protection), not re-run exhaustively again this session since nothing in this session's changes touches those flows beyond the environment-separation guard itself (which is build-time, not flow-specific) and the already-reverified MFA page.

## New regressions

**None.** Every number above either matches the established baseline exactly or improves on it with new, passing tests.
