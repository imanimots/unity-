# Prioritized Backlog — P0 (pre-launch blockers) / P1 (launch) / P2 (scale)

Cost estimates are deliberately omitted unless a range is directly supportable from evidence in the repo (e.g. existing vendor names) — per the audit brief's instruction not to fabricate costs.

## P0 — Pre-launch blockers (must resolve before treating this as production-ready)

| # | Item | Dependency | Acceptance test | Responsible |
|---|---|---|---|---|
| P0-1 | **Confirm actual Supabase backup frequency, PITR window, and region** via dashboard access | None — just needs access | A written record of: backup frequency, PITR enabled/window, project region | Technical Coordinator (needs Supabase dashboard login) |
| P0-2 | **Perform and document one real test restore** to a non-production Supabase project | P0-1 | Restore completes; time-to-restore recorded; data integrity spot-checked | Technical Coordinator + DB specialist |
| P0-3 | **Enforce MFA for all admin accounts** | Supabase Auth MFA policy (dashboard) + app-level AAL check in `requireAdmin()` | An admin login without a verified second factor is rejected; a non-MFA admin session cannot reach `/admin/*` | Security engineer |
| P0-4 | **Add external error monitoring/alerting** (e.g. Sentry) | Vendor account + `npm install` + basic instrumentation | A deliberately-triggered server error appears in the monitoring dashboard within minutes | Platform engineer |
| P0-5 | **Add malware/virus scanning to file uploads** (at minimum: listing photos and KYC documents, both currently unscanned) | Third-party scanning service (e.g. an AV API) or Supabase Storage's own scanning option if available | An uploaded test file with a known AV test signature (e.g. EICAR) is blocked before being stored | Security engineer |
| P0-6 | **Confirm POPIA cross-border data-transfer status** once region (P0-1) is known | P0-1 + Legal review | A written determination of whether any cross-border transfer rule applies | Legal + Technical Coordinator |
| P0-7 | **Build the cookie-consent banner** (already identified as a requirement in `docs/ARCHITECTURE.md` but never implemented) | Frontend work + Legal sign-off on banner copy/behavior | Banner blocks non-essential tracking until accepted; `analytics_events` ingestion respects the choice | Frontend engineer + Legal |
| P0-8 | **Wire the location (province/city) search filter** — the field already exists in the type but is never read by the query | Backend: read `filters.location` in `search_listings` / the RPC | Searching with a location filter returns only matching-location listings (test case #6 in Doc C) | Backend engineer |
| P0-9 | **Wire an availability/date-range filter into search** | Backend: join `listing_availability`/booking-overlap logic into `search_listings` | Searching with a date range excludes listings already booked for those dates (test case #7 in Doc C) | Backend engineer |

## P1 — Launch (should ship at/near launch, not immediately blocking)

| # | Item | Dependency | Acceptance test | Responsible |
|---|---|---|---|---|
| P1-1 | **Log admin reads of sensitive data** (KYC documents, payout bank details), not just mutations | Extend `audit-service.ts` pattern to read paths | Opening a KYC document as an admin produces an audit row | Security engineer |
| P1-2 | **Add failed-login-attempt tracking** | Supabase Auth log export, or an app-level counter | A deliberately-wrong password attempt is visible in a queryable log | Security engineer |
| P1-3 | **Extend field-level encryption to national ID/passport numbers**, matching the Vault treatment already given to bank account numbers | DB migration using the existing Vault pattern | ID number is stored via `vault.create_secret`, not plaintext | DB engineer |
| P1-4 | **Schedule the existing `cleanup_analytics_events()` cron**, and build the equivalent purge job for `email_deliveries`, copying the already-working `ad_impressions`/`ad_clicks` 90-day-purge cron pattern | None — pattern already exists in-repo | Both tables show bounded row counts over time in a scheduled job's logs | Platform engineer |
| P1-5 | **Add `created_at` indexes to `orders` and `payments`** | Single migration | `EXPLAIN` on a date-filtered query against either table shows index usage, not a seq scan | DB engineer |
| P1-6 | **Add Dependabot/Renovate** | `.github/dependabot.yml` | A dependency PR appears automatically within a week | Platform engineer |
| P1-7 | **Publish a precise data-retention schedule per data category**, replacing the current "as required for legal purposes" placeholder | Legal review | Privacy policy states a concrete period per category | Legal |
| P1-8 | **Add payment/handover/return/refund/dispute/payout analytics events**, extending the existing taxonomy pattern exactly (allowlist + Zod schema + service-role RPC) | None — pattern already exists | Each new event appears correctly in `analytics_events` with validated metadata | Data/product engineer |
| P1-9 | **Spot-check exact rate-limit thresholds** on login, password-reset, payment, and admin-mutation routes specifically | None | Each route's limit is read and recorded against expected values | Security engineer |

## P2 — Scale (defer until there's evidence of need; don't build speculatively)

| # | Item | Dependency | Acceptance test | Responsible |
|---|---|---|---|---|
| P2-1 | **Run the search test plan at seeded 1k/10k/100k-listing scale** (Doc C §5) in staging, measure real p50/p95 latency | A staging DB seeded at each scale | Latency numbers recorded; decide whether Postgres FTS remains sufficient | Backend engineer |
| P2-2 | **Reconsider a dedicated search engine** (Algolia or similar) only if P2-1's numbers show a real problem | P2-1 result | A documented decision either way, with evidence | Backend engineer / Technical Coordinator |
| P2-3 | **Add a synonym dictionary** to search | Domain-specific synonym list (e.g. fridge/refrigerator) | Test case #3 in Doc C passes | Backend engineer |
| P2-4 | **Add multilingual full-text search configuration** for Afrikaans/isiZulu, matching the existing en-ZA/af-ZA/zu-ZA UI locale support | Postgres text-search configuration per locale | Test case #11 in Doc C passes | Backend engineer |
| P2-5 | **Add a storage lifecycle/archival policy** for old dispute-evidence/rent-to-buy-evidence files once real usage data (from P0-1's dashboard access) shows meaningful growth | Usage data | A documented policy with a defined trigger threshold | Platform engineer |
| P2-6 | **Build marketing-attribution tooling (GA4/Meta/etc.)** only once the consent banner (P0-7) is live — never integrate a third-party ad pixel before that | P0-7 | New tracking never fires before consent is given | Marketing + Frontend |

## Dependency graph (high level)

```
P0-1 (backup/region check) ──┬──> P0-2 (test restore)
                              └──> P0-6 (POPIA residency determination)

P0-7 (consent banner) ──> P2-6 (any future ad-platform integration)

P1-1 (admin read-logging) and P1-2 (failed-login tracking)
   both build on the existing audit-service.ts pattern — do together

P2-1 (scale test) ──> P2-2 (search-engine decision)
```
