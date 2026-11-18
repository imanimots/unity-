# Unity Disaster Recovery Runbook

**Status: NOT VERIFIED.** This runbook was written without live Supabase/Vercel dashboard access (consistent with this project's standing Supabase-CLI/live-write-authorization policy). It documents the *procedure* to follow for each scenario below, based on what the application code and migration history show. **No scenario in this document has actually been executed or tested against a real environment.** Do not treat any "Estimated RTO/RPO" figure here as a verified capability — treat it as a target to validate, not a proven number. Section 8 lists the exact verification steps needed to close this gap.

## 1. Scope and ownership

| Field | Value |
|---|---|
| Owner | **TBD** — `docs/WAVE0_OPERATIONS.md` lists "Backup Ops: TBD"; this runbook cannot assign a name, only flag that one is needed before any of this is actionable in a real incident |
| Last verified via live restore test | **Never** (no evidence of one exists in this repository) |
| Primary data store | Supabase-managed Postgres 15, project ref `pwueguyrlcorurvbphej` |
| Primary object storage | Supabase Storage, 10 buckets (see §4) |
| Hosting | Vercel |

## 2. Proposed RTO/RPO targets (proposals, not verified capability)

| Data category | Proposed RPO | Proposed RTO | Basis for the proposal |
|---|---|---|---|
| Transactional database (bookings, payments, orders, disputes) | ≤ 5 minutes | ≤ 4 hours | Requires Supabase Point-in-Time Recovery on a paid tier — **not confirmed to be enabled** (§8) |
| Uploaded files (KYC documents, listing media, dispute evidence) | ≤ 24 hours | ≤ 24 hours | Object storage is typically backed up less frequently than the primary database; **not confirmed** |
| Search index (tsvector/GIN columns) | N/A | Time to restore `listings`/`marketplace_requests`/`barter_skill_task_posts` + reindex | Derived data — regenerated automatically from the restored rows, not a separate backup target |
| Application code/deployment | 0 (git history) | ≤ 15 minutes | Vercel redeploy from the last known-good commit; git history is the backup |

## 3. Scenario: Database corruption or accidental record deletion

1. **Stop writes** if the corruption is ongoing — this requires either pausing the affected API routes (feature flag / maintenance mode, neither currently exists in this codebase — see §8 gap) or, in the most severe case, suspending the Vercel deployment.
2. **Do not run any destructive command locally** (`DROP`, `TRUNCATE`, manual `DELETE`) in an attempt to "fix" the data — this project's standing policy is that any direct SQL/CLI access against the live database is explicitly off-limits outside the Supabase GitHub deploy integration.
3. Escalate to whoever holds Supabase dashboard access for this project. Determine, from the dashboard (Database → Backups), the latest available restore point.
4. **Restore into a NEW, separate Supabase project first** — never restore directly over the live project without first confirming the backup contains what's expected. This project's own `docs/PUBLIC_TEST_RUNBOOK.md` already documents that a Supabase dashboard restore is destructive to anything created after the backup point — the same caution applies doubly in a real incident, where the cost of restoring the wrong point is much higher than in a QA context.
5. Once the restore target is confirmed correct, follow Supabase's own documented procedure to promote/point the application at it (exact mechanism depends on the Supabase plan tier — **not confirmed in this document**, needs the dashboard to know).
6. Re-run `supabase migration list --linked` (per `docs/PUBLIC_TEST_RUNBOOK.md`'s existing deploy-safety convention) to confirm the restored database's migration state matches what the application code expects before resuming traffic.
7. Post-incident: reconcile any transactions that occurred between the backup point and the incident (the gap = your actual, realized RPO for this incident) against the application's own audit trails (`admin_action_history`, `ledger_entries`, `booking_history`, `order_history` — all immutable, append-only, and would have captured activity right up to the moment of failure if the corruption was localized rather than total).

## 4. Scenario: Storage-object loss (a bucket or specific files)

Reference inventory (from `supabase/migrations/*.sql`, see the technical audit's Doc E for full detail):

| Bucket | Sensitivity | Recovery note |
|---|---|---|
| `listing-media` | Public, non-sensitive | Loss is a product-quality issue (broken images), not a data-integrity one — no PII |
| `avatars` | Public, non-sensitive | Same |
| `rental-media` | Private, transaction evidence | Loss weakens dispute-evidence quality for affected bookings |
| `ownership-proofs` | Private, merchant+admin only | Loss affects listing moderation evidence, not an active transaction |
| `kyc-documents` | Private, highest sensitivity | Loss would require affected users to **re-submit** KYC — the `identity_verification_documents` table (append-only) still records that a submission existed even if the file is gone, so this is detectable, not silent |
| `dispute-evidence`, `rent-to-buy-evidence`, `barter-offer-media`, `barter-milestone-evidence`, `chat-attachments` | Private, transaction-specific | Loss affects the specific dispute/agreement's evidentiary record |

**Procedure:**
1. Confirm via the Supabase dashboard (Storage) whether the bucket/object is genuinely gone or a transient access error.
2. Object storage does not share the database's PITR mechanism — **confirm separately with Supabase support/dashboard whether object storage has its own backup/versioning** (this project's audit found no code-level evidence either way; §8).
3. For `kyc-documents` specifically: because the table is append-only and a resubmission always creates a new object at a new path (never an overwrite — see `20260804000001_identity_verification_schema.sql`'s own header), a genuinely lost file is indistinguishable, from the database's point of view, from "never completed" — the affected user will need to resubmit. Notify them; do not attempt to fabricate a replacement record.
4. For transaction-evidence buckets (dispute/RTB/barter), check whether the referencing row (`dispute_evidence`, etc.) still has other evidence or a text description that can stand in while the file is unrecoverable.

## 5. Scenario: Application deployment failure

1. Vercel's own deployment history is the primary recovery mechanism — redeploy the last known-good commit via the Vercel dashboard or `vercel rollback` (requires Vercel CLI access, not available in this session).
2. If the failure was caused by a migration that's incompatible with the currently-deployed code (a schema/code version mismatch), the project's standing forward-fix-only policy means the correct recovery is a **new, forward migration** that corrects the issue — never a rollback migration. This mirrors the existing pattern of "restore_*"-named migrations already in this codebase's history (e.g. `20261107173218_restore_dispute_fix_forward_semantics.sql`).
3. Confirm via the baseline checks (typecheck, lint, build, vitest — see this programme's own Batch commits for the exact sequential order used throughout this engagement) before considering the incident closed.

## 6. Scenario: Supabase outage (upstream, not Unity's fault)

1. The application has no fallback for Supabase itself — it is a hard dependency by design (confirmed in the technical audit, Doc E §8). There is no graceful-degradation code path for "the database is unreachable" beyond individual routes returning a 503 when `getAdminServiceClient()`/`createClient()` can't be configured — that check is for *missing configuration*, not a *live outage*, and routes do not currently distinguish the two.
2. Monitor Supabase's own status page. There is no automated alerting wired into this codebase today (confirmed audit gap — no Sentry/Datadog equivalent) — **this is the single most actionable gap for this specific scenario**: without it, the team's first signal of an outage is likely a user report, not an internal alert.
3. No action is possible on Unity's side beyond communicating status to users (e.g. a status page, not currently built) until Supabase's own service recovers.

## 7. Scenario: Compromised credentials / security incident

1. Rotate the suspected-compromised credential immediately (Supabase service-role key, `SUPABASE_SERVICE_ROLE_KEY`, via the Supabase dashboard; any other API key similarly via its own provider console). This is an irreversible, environment-affecting action — confirm with whoever owns production access before rotating a key that active deployments depend on, since rotation without simultaneously updating the deployed environment variable will cause an outage.
2. Review `admin_action_history`/`user_account_history`/the new `admin_kyc_document_access_log` (added by this programme) for any activity attributable to the compromised credential's access window.
3. This codebase has no documented POPIA breach-notification procedure (confirmed audit gap, Doc D) — **escalate to legal/counsel immediately**, in parallel with the technical response, not after it. This runbook cannot substitute for that legal process.
4. Force-expire active sessions if the compromise could have touched user-session tokens (Supabase Auth dashboard — exact mechanism not independently verified in this pass).

## 8. What this runbook cannot verify without live access (explicit, not glossed over)

- Whether Supabase automatic backups are actually enabled for this project, and at what frequency/retention.
- Whether Point-in-Time Recovery is available/enabled on the current plan tier.
- Whether Supabase Storage has any backup/versioning mechanism independent of the database backup.
- Whether a restore has ever actually been performed, by anyone, on this project.
- The actual mechanism/time cost of promoting a restored project to replace the live one on this specific Supabase plan tier.
- Vercel's own deployment-rollback mechanics for this specific project configuration.

**These six items are the actual next steps for this runbook** — closing them (via Supabase/Vercel dashboard access) is what would convert the "proposed" RTO/RPO targets in §2 into verified, defensible numbers. Until then, this document describes a reasonable procedure, not a proven one.
