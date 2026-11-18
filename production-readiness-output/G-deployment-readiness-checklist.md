# G — Deployment Readiness Checklist

## Required migrations (in order, all already written, none yet deployed)

1. `20261118092747_search_listings_location_and_availability_filters.sql`
2. `20261118094500_analytics_events_lifecycle_expansion.sql`
3. `20261118095132_email_deliveries_retention_cleanup.sql`
4. `20261118095252_orders_payments_created_at_indexes.sql`
5. `20261118095532_admin_kyc_document_access_log.sql`

All five are additive (new tables/columns/indexes/trailing RPC parameters with defaults) — none drop or rename an existing column, and the `search_listings` migration specifically preserves the exact prior positional-type signature by appending new parameters at the end, confirmed safe for `CREATE OR REPLACE` per Postgres's own documented contract for this. No data migration/backfill is required for any of them.

## Required configuration changes

- `vercel.json`: add the 2-line cron entry from `docs/operations/VERCEL_JSON_CRON_CHANGE_SPEC.md` — requires your approval since that file is parked.
- `ADMIN_MFA_ENFORCED`: leave unset (default off) until the rollout checklist is complete. Not a deployment blocker — its absence is the safe state.

## Vendor dependencies

- None required for anything in this deployment package to function. Malware scanning and error monitoring are documented as future work, not a dependency of what's ready now.

## Feature flags

- `ADMIN_MFA_ENFORCED` is the only new one. Everything else in this deployment package (search filters, analytics events, consent banner, retention jobs, indexes, KYC access logging) is unconditional — there is no flag gating any of it, by design, since none of them carry the kind of lockout/behavior-change risk that justified a flag for MFA specifically.

## Deployment sequence

1. Merge to `main` (your decision, not performed this session).
2. The Supabase GitHub deploy integration applies the 5 migrations automatically on merge, in filename order.
3. Deploy the application code (Vercel's normal flow on a `main` push).
4. **Separately**, once you're ready: edit `vercel.json` (the one parked-file exception, with your explicit approval) to schedule the two new cron routes.
5. **Separately, much later**, once the MFA rollout checklist is fully complete: set `ADMIN_MFA_ENFORCED=true`.

Steps 4 and 5 are deliberately decoupled from step 1-3's main deployment — neither requires a code redeploy, both are pure configuration, and both have their own independent prerequisite (file-parking approval; completed admin enrollment) that may land on a different timeline than the code merge itself.

## Verification tests to run post-deployment

- The full baseline (typecheck/lint/build/vitest) — already clean pre-deployment; re-running post-deployment on `main` confirms the merge itself didn't introduce anything.
- `rls-negative-access.spec.ts` against the now-live schema (confirms the new `admin_kyc_document_access_log` RLS policy behaves as written, not just as reviewed).
- `authenticated-smoke.spec.ts` (renter + admin) against the live deployment.
- A manual check that `search_listings` now accepts the new province/city/date parameters live (the exact query this session couldn't run, since the migration wasn't deployed yet — this becomes possible immediately after step 2).

## Rollback procedures

- **Code:** Vercel's standard redeploy-previous-version mechanism (dashboard access needed, not used this session).
- **Migrations:** this project's standing forward-fix-only convention means a bad migration is fixed with a new, forward migration — never a destructive rollback migration. If a newly-deployed migration proves wrong, the correct response is a follow-up `CREATE OR REPLACE`/`ALTER TABLE` migration undoing the specific effect, reviewed with the same care as any other change.
- **Config:** `ADMIN_MFA_ENFORCED` and the `vercel.json` cron entries are both trivially reversible (unset the env var; remove the cron lines) with no code redeploy needed.

## Expected customer impact

| Change | Customer-visible impact |
|---|---|
| Search location/date filters | Positive — renters can now filter by location/availability, closing a real discoverability gap |
| New analytics events | None directly visible — behind-the-scenes instrumentation |
| Consent banner | Visible on first visit to any public page — a new UI element every visitor will see once |
| Retention job scheduling | None visible — internal housekeeping |
| `created_at` indexes | None visible directly — a future query-performance improvement as these tables grow |
| Admin KYC access logging | None visible to customers — admin-only audit trail |
| Admin MFA (while `ADMIN_MFA_ENFORCED` stays unset) | **None** — zero customer or admin-facing change until explicitly enabled later |

**Nothing in this deployment package is customer-impacting in a way that needs advance user communication**, with the consent banner being the one new thing every visitor will actually see.
