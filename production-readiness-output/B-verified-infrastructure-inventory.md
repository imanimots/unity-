# B — Verified Infrastructure Inventory

For every item: **Verified configuration | Evidence source | Verification date | Risk | Recommended action | External approval needed?**

## Supabase

| Item | Status | Evidence | Date | Risk | Action | Approval needed |
|---|---|---|---|---|---|---|
| Project reference | Verified: `pwueguyrlcorurvbphej` | `.env.local` URL (name confirmed, value not printed), `supabase/config.toml` | This session | — | — | No |
| Database version | Verified: Postgres 15 | `supabase/config.toml` `[db] major_version = 15` | This session | — | — | No |
| Total `listings` rows | **Verified: 9,270** | Live read-only count query, this session | This session | — | — | No (read-only) |
| Real/eligible `listings` rows | **Verified: 10** (`status='active' AND is_test=false`) | Live read-only query, this session | This session | **Informational — any search-performance claim must distinguish "9,270 rows" from "10 real listings"** | Interpret future scale tests against this baseline honestly | No |
| `email_deliveries` rows | **Verified: 23,109**, oldest 2026-08-01, 0 rows older than 180 days | Live read-only query, this session | This session | Low — confirms the retention job (built, not yet scheduled) has real work to eventually do, no urgent backlog today | Schedule the cron (see Doc G) | No (scheduling itself needs `vercel.json` approval) |
| `profiles`/`bookings`/`orders`/`payments`/`disputes`/`analytics_events` row counts | Verified: 314 / 1,558 / 1,901 / 3,235 / 695 / 1,107 | Live read-only queries, this session | This session | — | — | No |
| Storage bucket top-level entry counts (10 buckets) | Verified: all light usage (0-138 top-level folders) | Live `.storage.list()` calls, this session | This session | Low — confirms no current storage-scale concern | Revisit if/when real usage grows | No |
| **Project region** | **NOT VERIFIED** | No Supabase Management API token exists in this environment — confirmed this session (only data-plane anon/service-role keys present) | This session | Blocks the POPIA cross-border determination | Someone with dashboard access must check Project Settings → General | **Yes — Supabase dashboard access** |
| **Backup frequency/retention** | **NOT VERIFIED** | Same reason | This session | High — the single most consequential unknown in this entire programme | Check Database → Backups | **Yes** |
| **Point-in-time recovery availability** | **NOT VERIFIED** | Same reason | This session | High | Check plan tier + Database → Backups | **Yes** |
| **Replication/high availability** | **NOT VERIFIED** | Same reason | This session | Medium | Check plan tier | **Yes** |
| **Database access restrictions (network/IP allow-listing etc.)** | **NOT VERIFIED** | Same reason | This session | Medium | Check Project Settings → Database | **Yes** |
| **Production vs. staging separation** | **Verified: there is no separation — one project serves both.** | `docs/PUBLIC_TEST_RUNBOOK.md`'s own existing text: "This is a development project, not a future production project — do not point a real production deployment at this same Supabase project." Cross-confirmed this session by the fact that the only "real" data (10 listings) sits in the exact same tables as 9,259 test-fixture rows. | This session (cross-confirmed) | **High — this is itself a launch-blocking architectural fact, not a missing-information gap** | A genuine production launch needs a separate Supabase project, not a flag within this one | **Yes — a real decision, not just dashboard access** |

## Vercel

| Item | Status | Evidence | Risk | Action |
|---|---|---|---|---|
| Current cron config | Verified: 1 entry (`advertising/purge-events`, daily 03:00) | `vercel.json`, read this session | — | — |
| Deployment region, env var inventory beyond names, rollback mechanics | **NOT VERIFIED** | No Vercel dashboard/CLI access this session | Medium | Needs Vercel dashboard access |

## Monitoring

| Item | Status |
|---|---|
| Any error-monitoring/alerting tool | **Verified absent** — confirmed again this session via the same exhaustive grep the preceding audit used; nothing changed |

## Security

| Item | Status | Evidence |
|---|---|---|
| RLS negative-access enforcement | **Verified, live, this session** | 5/6 `rls-negative-access.spec.ts` tests pass against real data (1 skipped, data-availability) |
| Admin MFA enforcement | **Verified: code exists, confirmed OFF** (`ADMIN_MFA_ENFORCED` unset) | This session's new code + test suite |
| Admin KYC-document-read logging | **Verified: table does not yet exist on the live database** — the migration adding `admin_kyc_document_access_log` is committed to this branch but not deployed (migrations only apply via the GitHub-integration merge-to-main flow). Confirmed via a live read: `PGRST205 — Could not find the table 'public.admin_kyc_document_access_log' in the schema cache`. | Live read-only probe, this session |

No credentials, project secrets, or confidential configuration values are printed anywhere in this document or elsewhere in this report.
