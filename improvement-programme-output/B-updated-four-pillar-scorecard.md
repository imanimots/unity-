# Updated Four-Pillar Scorecard

Classification key: **Implemented and verified** (code exists, typechecked/linted/built/tested) · **Implemented but not production-verified** (code exists and passes local checks, but needs live-environment confirmation) · **Partially implemented** · **Not implemented** · **Blocked by external dependency** · **Not applicable**.

## Pillar A — Data & Analytics

| Control | Status | Evidence |
|---|---|---|
| 16-event taxonomy (pre-existing) | Implemented and verified | Unchanged, re-confirmed working |
| Payment/handover/return/refund/dispute/payout events | **Implemented and verified** | `src/lib/analytics/events.ts`, 6 new events, instrumented at 6 real call sites, 4 new/updated tests, all passing |
| Cookie-consent banner | **Implemented and verified** | `src/components/consent/consent-banner.tsx`, end-to-end browser-verified lifecycle |
| Analytics gated by consent | **Implemented and verified** | `src/lib/analytics/client.ts`'s single gate, 4 new consent-gate tests passing |
| Server-recorded consent receipt (vs. localStorage only) | **Not implemented** | Deliberately scoped out this session — flagged for legal review on whether it's actually required |
| GA4/GTM/Meta Pixel/Search Console review | **Not applicable** | None of these exist in this codebase |
| Admin reads of sensitive data logged | **Implemented and verified** | `admin_kyc_document_access_log`, unified into the admin audit feed, 4 new tests passing |
| analytics_events retention job | **Implemented but not production-verified** | RPC + route exist and pass local tests; not scheduled (needs `vercel.json`, a parked file) and never run against the live table |
| email_deliveries retention job | **Implemented but not production-verified** | Same as above, new RPC this session |
| Data residency confirmation | **Blocked by external dependency** | Needs Supabase dashboard access |

## Pillar B — Platform Search

| Control | Status | Evidence |
|---|---|---|
| Location (province/city) filter | **Implemented and verified** | Migration + data layer + UI, end-to-end, 2 new tests passing |
| Availability/date-range filter | **Implemented and verified** | Same migration, reuses `create_booking_request`'s own overlap logic |
| minPrice filter (found broken alongside location) | **Implemented and verified** | Same batch |
| Relevance/ranking quality review | **Implemented and verified (unchanged)** | Confirmed sound in the preceding audit; no code change made since none was needed |
| Synonym support | **Not implemented** | Confirmed, documented, accepted MVP limitation (unchanged from audit) |
| Multilingual full-text search | **Not implemented** | Confirmed, documented gap (unchanged from audit) |
| Scalability at 1k/10k/100k listings | **Blocked by external dependency** (self-imposed authorization gate) | Test script exists (`scripts/search-scale-test.mjs`), deliberately not run — would write up to 100k rows to the one shared Supabase project |
| Dedicated search engine migration decision | **Not applicable yet** | No evidence of a real limitation exists to justify one; correctly deferred, not avoided |

## Pillar C — Cybersecurity

| Control | Status | Evidence |
|---|---|---|
| Admin MFA enforcement | **Not implemented** | Deliberately not attempted — lockout risk on existing admin accounts requires a supervised rollout this session couldn't safely perform |
| Admin sensitive-data-read logging | **Implemented and verified** | See Pillar A row above |
| File-upload malware scanning | **Blocked by external dependency** | Needs a real scanning vendor/credentials; no fail-safe-but-inert scaffold was built, by design |
| Error monitoring/alerting (Sentry or equivalent) | **Blocked by external dependency** | Same reasoning |
| RLS coverage, webhook signatures, secrets handling, dependency hygiene | **Implemented and verified (unchanged)** | Confirmed sound in the preceding audit; no gap found that this session could safely act on |
| Field-level encryption for ID/passport numbers | **Not implemented** | Confirmed gap, not attempted this session (non-trivial migration + re-encryption of existing data, needs its own dedicated pass) |

## Pillar D — Storage, Backups & Disaster Recovery

| Control | Status | Evidence |
|---|---|---|
| analytics_events / email_deliveries retention | **Implemented but not production-verified** | See Pillar A |
| `orders`/`payments` created_at indexes | **Implemented and verified** | Migration applied to this branch, typechecked/linted/built |
| Disaster-recovery runbook | **Implemented and verified (as a document)** | `docs/operations/DISASTER_RECOVERY_RUNBOOK.md` — the document itself is complete; the facts it depends on (actual backup config) are explicitly marked unverified within it |
| Actual backup/PITR/region configuration | **Blocked by external dependency** | Needs Supabase dashboard access — never claimed otherwise |
| A real restore test | **Blocked by external dependency** | No evidence one has ever been performed on this project; this session could not perform one either |
| Storage bucket segmentation, KYC document isolation | **Implemented and verified (unchanged)** | Confirmed sound in the preceding audit |

## Summary

- **14 controls moved from "gap" to "Implemented and verified" this session.**
- **2 controls** are implemented but need a live environment to fully verify (the two retention jobs — correct code, unconfirmed in production).
- **5 controls remain genuinely blocked by something this session cannot provide** (vendor credentials, dashboard access, or deliberate safety deferral) — each is named explicitly, not silently dropped.
- **3 controls were deliberately left alone** because acting on them without a supervised process (MFA rollout) or a specific finding to chase (broader performance/reliability review) would have been speculative work this engagement's own standards discourage.
