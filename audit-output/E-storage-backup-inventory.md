# Pillar D — Storage, Backup & Disaster Recovery Inventory

## 1. Database

- Postgres 15 via Supabase (`supabase/config.toml`, project ref `pwueguyrlcorurvbphej`).
- 265 migration files, earliest `20260613000001_initial_schema.sql`, latest `20261117170000_fix_cancel_booking_concurrent_accept_race.sql` — roughly 5 months of continuous schema evolution.
- Forward-fix-only migration policy, explicitly documented: "No destructive rollback migrations exist for applied schema... per this project's standing convention" (`docs/PUBLIC_TEST_RUNBOOK.md:333-334`). Deploy safety check documented via `supabase migration list --linked` before deploy.

## 2. Object storage — full bucket inventory

| Bucket | Public? | Size limit | Allowed types | Contents | Citation |
|---|---|---|---|---|---|
| `listing-media` | **Yes** | 50 MB | jpeg/png/webp/heic/mp4/quicktime | Listing photos/video | `initial_schema.sql:443-449` |
| `avatars` | **Yes** | 5 MB | images | Profile pictures | `initial_schema.sql:454-459` |
| `rental-media` | No | 50 MB | images/video | Pre/post-rental condition evidence, booking parties only | `initial_schema.sql:466-472` |
| `ownership-proofs` | No | 20 MB | jpeg/png/webp/pdf | Proof-of-ownership (receipts/serials), merchant + admin only | `initial_schema.sql:478-484` |
| `kyc-documents` | No | 10 MB | jpeg/png/webp/pdf | Identity/verification documents | `20260804000001_identity_verification_schema.sql:234-242` |
| `barter-offer-media` | No | 10 MB | images/mp4 | Barter offer evidence | `20260810000004_barter_offer_media.sql:59-64` |
| `chat-attachments` | No | 10 MB | jpeg/png/webp/pdf | In-chat file sharing | `20260815000001_message_attachments.sql:74-80` |
| `dispute-evidence` | No | 10 MB | images/pdf | Dispute supporting evidence | `20260814000005_dispute_evidence.sql:44-50` |
| `rent-to-buy-evidence` | No | 20 MB | images/mp4 | RTB condition/handover evidence | `20260821183555_rtb_v2_schema.sql:185-191` |
| `barter-milestone-evidence` | No | 10 MB | images | Barter milestone proof | `20260901000005_skills_tasks_barter_milestone_evidence.sql:41-47` |

**9 of 10 buckets are correctly private**; only `listing-media` and `avatars` are public, which is appropriate (public product photos and avatars are meant to be publicly viewable).

## 3. KYC document isolation (verified strongest-protected bucket)

`kyc-documents` has its own dedicated bucket (not shared with listing media), with policies limited to: self-upload, self-read, and admin-read (`20260804000001_identity_verification_schema.sql:245-262`). **No UPDATE or DELETE policy exists at all** — a resubmission creates a new object at a new UUID path rather than overwriting, preserving a complete history by construction. This is a strong, deliberate design choice.

## 4. Log/event table growth and retention

| Table | Growth driver | Retention mechanism | Status |
|---|---|---|---|
| `analytics_events` | Every tracked user action | `cleanup_analytics_events()` RPC exists, 365-day default window | **Exists but not scheduled** — "no cron dependency" by the migration's own comment; must be invoked manually/externally today |
| `email_deliveries` | Every system email | None found | **Unbounded growth** |
| `ad_impressions` / `ad_clicks` | Ad view/click events | `purge_expired_ad_events()` RPC, **scheduled daily at 03:00** via `vercel.json` cron, 90-day retention | **Working precedent** — this exact pattern should be copied for the two tables above |
| `admin_action_history`, `identity_verification_history`, `user_account_history`, `account_erasure_log` | Admin/user lifecycle actions | None — intentionally immutable and never pruned (audit-trail design) | By design, not a gap |

## 5. Indexing on high-growth tables

| Table | `created_at`-equivalent index? | Other indexes | Note |
|---|---|---|---|
| `bookings` | **Yes** — `bookings_created_at_idx`, plus `bookings_status_listing_idx`, `bookings_start_at_idx` | Best-indexed table in the schema | — |
| `ledger_entries` | **Yes** — `ledger_entries_created_idx` | — | — |
| `orders` | **No** | buyer_id, seller_id, listing_id, status, order_reference | Gap — cheap to fix |
| `payments` | **No** | order_id, booking_id, renter_id, merchant_id, status, barter/rtb agreement ids | Gap — cheap to fix |

## 6. Right-to-erasure / retention (POPIA)

`erase_account()` RPC (`supabase/migrations/20261022000000_account_erasure.sql`, 441 lines): anonymizes `profiles`/`identity_verifications` in place (hard delete deemed unsafe given FK and immutability constraints), under a new terminal `'erased'` status. Blocked while active bookings/disputes/unsettled orders/active RTB agreements exist. Logged immutably to `account_erasure_log`. Explicitly **never** deletes `bookings`, `orders`, `disputes`, `reviews`, `messages`, `payments`, `payouts`, `ledger_entries`, or history tables — preserved for legal/financial-record reasons. This is a mature, well-reasoned implementation.

## 7. Backups, RTO, RPO

**UNKNOWN / NOT VERIFIABLE FROM CODE.** The only backup-related statements found anywhere in the repository:

> "Supabase's own daily backups (dashboard → Database → Backups) are the backup strategy for this phase — no additional export tooling was built, since a destructive loss of QA data is recoverable by re-running `npm run qa:seed`." — `docs/PUBLIC_TEST_RUNBOOK.md:158-159`

> "This is a development project, not a future production project — do not point a real production deployment at this same Supabase project." — `docs/PUBLIC_TEST_RUNBOOK.md:155-156`

> `Backup Ops | TBD` — an unfilled staffing role, `docs/WAVE0_OPERATIONS.md:90`

No RTO or RPO figure is defined anywhere in the repository (zero grep hits for "RTO", "RPO", "disaster recovery", "point-in-time").

### Proposed RTO/RPO targets (PROPOSALS — not current measured capability; to be confirmed against actual Supabase plan tier)

| Data category | Proposed RPO | Proposed RTO | Basis |
|---|---|---|---|
| Transactional database (bookings, payments, orders) | ≤ 5 minutes (requires Supabase PITR on a paid tier) | ≤ 4 hours | Financial-record integrity is the highest-stakes category |
| Uploaded files (KYC, listing media, dispute evidence) | ≤ 24 hours | ≤ 24 hours | Object storage typically backed up less frequently than the DB |
| Search index (tsvector/GIN) | N/A — rebuilt automatically from `listings` on restore | Time to restore `listings` table + reindex | Derived data, not an independent backup target |

**These targets cannot be confirmed as met without the live Supabase dashboard.** Treat them as a starting proposal for a production readiness conversation, not a claim about current capability.

### Restore-evidence checklist (none of this is currently satisfied, per repo evidence — to be completed with vendor access)

- [ ] Confirm Supabase project backup frequency (Dashboard → Database → Backups)
- [ ] Confirm whether Point-in-Time Recovery is enabled, and its retention window
- [ ] Confirm whether backups are stored independently/immutably from the primary (vendor-managed, should be confirmed not assumed)
- [ ] Confirm who has access to trigger a restore, and that access is appropriately restricted
- [ ] **Perform and document at least one actual test restore** (to a non-production project) and record the time it took — no evidence of this ever having been done exists in the repo
- [ ] Define and document actual RPO/RTO targets once the above is known, and compare against the proposed targets in this document

## 8. Single points of failure / vendor fallback behavior

| Vendor | Role | Fallback on outage | Evidence |
|---|---|---|---|
| Supabase | DB/Auth/Storage | **None — hard dependency**, entire app non-functional | By nature of the architecture |
| Sumsub (KYC) | Identity verification | Not confirmed to have a fallback | Likely a hard dependency for the KYC submission flow specifically |
| Payment provider (Peach) | Checkout/payments | Not confirmed to have a fallback | Likely a hard dependency for checkout specifically |
| Voyage AI | Embeddings for AI assistant search | **Graceful** — returns `null` embedding, falls back to full-text index | `src/lib/assistant/embedding.ts:14-29` |
| Upstash Redis | Rate limiting | **Graceful** — falls back to in-memory limiter, never to "no limit" | `src/lib/rate-limit-distributed-adapter.ts:18-22,34-44` |
| Anthropic | AI assistant chat | **Graceful** — documented canned-response fallback | `docs/PUBLIC_TEST_RUNBOOK.md` |

The three "hard dependency" rows (Supabase, Sumsub, payment provider) are normal and expected for their respective critical paths — flagging them is about awareness for incident response planning, not a defect to fix.

## 9. Data residency

**UNKNOWN / NOT VERIFIABLE FROM CODE.** No `supabase/config.toml` region field, no `vercel.json` `regions` key, no `next.config.ts` region setting. `docs/ARCHITECTURE.md:33` only says the region should be "considered" for Cape Town — aspirational, not configured. **Would need:** Supabase Dashboard → Project Settings → General, and Vercel Dashboard → Project Settings → Functions/Regions.

## 10. Storage cost/capacity scaling (TEST PLAN — not measured)

No actual usage/cost figures exist in the repo (would need Supabase/Vercel billing access). As a planning exercise only:

| Listings scale | Rough storage driver | What to actually measure (not claimed here) |
|---|---|---|
| 1,000 | ~3-10 photos/listing × avg photo size | Actual `listing-media` bucket size via Supabase dashboard |
| 10,000 | 10x the above, plus proportional KYC/dispute-evidence growth | Same, at 10x — confirm cost scales roughly linearly, not superlinearly (would reveal a missing lifecycle policy) |
| 100,000 | 100x | At this scale, confirm whether any bucket needs a lifecycle/archival policy (e.g. moving old dispute evidence to cheaper storage) — no such policy exists in the repo today |

This table intentionally contains no invented numbers — it is a plan for what to measure, not a result.
