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

## Production risk classification

Every planned production action from this and the prior session, classified Low/Medium/High/Critical:

| Action | Risk | Why |
|---|---|---|
| Merging the 7 code/migration commits to `main` | **Medium** — reversible application change, but requires deployment review | Additive schema changes + new routes; no data-destructive step; standard review-before-merge applies |
| The 5 migrations auto-applying via the GitHub deploy integration | **Medium** | Additive only (new tables/columns/indexes/trailing params) — no drop, no rename, no backfill; still a production database change and gets deployment review as a matter of course |
| Editing `vercel.json` to add 2 cron lines | **Low** | Documentation-adjacent, fully reversible, no customer-facing effect |
| Setting `ADMIN_MFA_ENFORCED=true` | **High** — authentication-enforcement change | Can lock out an admin if the rollout checklist wasn't followed; explicitly gated behind that checklist, never a same-step action with the code merge |
| Provisioning a malware-scanning or error-monitoring vendor | **Low** (the signup/config itself) | No production data at risk from the act of provisioning; the *integration* once built would be Medium (touches the upload path) |
| Running `scripts/search-scale-test.mjs` against the shared project | **Medium** — reversible, but writes real (if synthetic) data at volume to a shared environment, with real time cost | Not executed this session; would need your explicit sign-off first, consistent with its own Medium classification, not treated as routine |
| Provisioning a genuinely separate production Supabase project | **Critical** — affects existing customer access and the entire data model's integrity going forward | This is the one item on this entire report that is a true architectural decision, not a configuration change; it is also the one no amount of further code work resolves on its own |
| A real backup/restore test | **Critical**, if performed against anything other than a disposable copy; **Low**, if performed correctly (restore into a new, separate project, never over the live one) | The DR runbook's own §3 procedure exists specifically to keep this in the Low category by construction |
| Rotating a compromised credential | **Critical** | Affects existing customer access if done without simultaneously updating the deployed environment; the DR runbook's §7 procedure names this explicitly |

**No action in this list was executed at High or Critical risk this session.** Everything actually performed (the 9 committed files, the live read-only Supabase queries, the live E2E test runs) falls at Low or, at most, the Medium tier reserved for a reviewed-but-unmerged code change — consistent with this phase's own instruction not to execute material production changes merely because they passed local testing.

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
