# D — Database and Disaster-Recovery Status

## Backup availability

**NOT VERIFIED.** No Supabase Management API token exists in this environment (confirmed this session — only the project's own anon/service-role data-plane keys are present). This is the same gap the prior programme reported; this session did not close it, because closing it requires a credential this session does not have, not more engineering effort.

## Backup restoration options

**NOT VERIFIED**, same reason.

## Storage-file backup coverage

**NOT VERIFIED.** Object storage typically has its own, separate backup posture from the database — nothing in this codebase confirms one way or the other.

## Recovery permissions

**NOT VERIFIED** — unknown who currently holds the access needed to trigger a Supabase restore.

## Required vendor support

Supabase itself, for any restore beyond what a dashboard self-service action covers. Unknown whether this project's plan tier includes PITR or requires a support request to restore from a daily snapshot.

## Recovery environment requirements

Per `docs/operations/DISASTER_RECOVERY_RUNBOOK.md` (written in the prior session): any restore must go to a **new, separate Supabase project first**, never directly over the live one, to confirm the backup contains what's expected before cutting over.

## Configuration and secrets recovery procedures

**Not formally documented beyond "rotate the credential and update the deployed environment variable."** This is a real gap — there is no inventory of exactly which secrets would need re-issuing in a full recovery scenario, beyond the env var *names* already known (`CRON_SECRET`, `INTERNAL_CRON_SECRET`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, plus whatever payment/KYC-provider secrets exist that this session has not enumerated).

## Was a restore test performed?

**No.** No Docker, no local Postgres binary, and no Supabase Management API access exist in this environment (all three confirmed this session) — there is no way to safely attempt one here. This is not a deferred "ran out of time" item; it is a genuine capability gap in this specific execution environment.

## Measured recovery evidence

**None exists for this project, at any point in its history**, as far as this or the prior session's investigation could determine — no evidence of a restore ever being performed was found in the codebase, documentation, or this session's live read-only checks.

## Proposed RTO/RPO (unchanged from the prior session, still proposals, not measurements)

| Data category | Proposed RPO | Proposed RTO |
|---|---|---|
| Transactional database | ≤ 5 minutes | ≤ 4 hours |
| Uploaded files | ≤ 24 hours | ≤ 24 hours |
| Search index | N/A (derived, rebuilt automatically) | Time to restore underlying tables + reindex |

## The one new, more consequential finding this session adds

**This project has no production/staging separation at all.** The same Supabase project holding 10 real listings also holds 9,259 QA test-fixture rows, 314 profiles (a mix of real and test accounts), and so on. A disaster-recovery plan for *this* project is, today, a disaster-recovery plan for a combined dev/QA/real-data environment — which materially changes what "recovery" even means here (e.g., a restore to an earlier point could legitimately be expected to reintroduce or remove QA fixtures alongside real data, since they live in the same tables with no structural separation beyond the `is_test` flag). This is worth stating plainly: **a genuine production launch should use a dedicated Supabase project**, not a flag-based separation within the one that's been used for every phase of this entire engagement.
