# Dispute System (Step 11 Phase 2)

One generic dispute workflow, reused identically by bookings, orders, and barter agreements — not three separate dispute domains. This document covers what was built, how it works, and what's deliberately deferred.

## What existed before this phase

`disputes` has existed since the very first migration and was already widened twice (`order_id` in Step 7, `barter_agreement_id` in Step 11 Phase 1) — but **zero application code had ever touched it**: no RPC, no real API route, no real UI. `src/app/admin/disputes/page.tsx` was a static "not built yet" stub whose own comment incorrectly claimed the table didn't exist at all — false, confirmed by reading the migrations directly. `src/components/trust/dispute-form.tsx`'s submit handler was a bare `setTimeout`, never called an API, and both booking-dispute pages that rendered it were entirely mock-mode-gated (hard 404 in real mode). Both the mock form and its mock data (`src/lib/mock/disputes.ts`) were deleted in this phase — fully orphaned once real submission replaced them.

## Architecture

Continues every established pattern in this codebase — no new architecture:
- `SECURITY DEFINER` RPCs, `service_role`-only, idempotency-keyed via the same generic `idempotency_keys` table and `checkIdempotentReplay()` every other domain reuses.
- Append-only, immutable history via the shared `prevent_row_mutation()` trigger.
- The same admin route/service shape (`requireAdminForRoute`, `getAdminServiceClient`, a plain `listX`/`getXDetail` service module, `csvResponse`).
- The same email `sendTemplate()` API and catalogue-array shape.
- The same storage-bucket-plus-path-prefix-RLS pattern already proven by `barter_offer_media`.

## Lifecycle

```
OPEN → EVIDENCE → UNDER_REVIEW → RESOLVED → CLOSED
  ↓         ↓            ↓
  └─────────┴──── CANCELLED (admin only, any non-terminal state)
```

`evidence` is re-enterable from `open` or `under_review` (an admin can request more evidence at either point). Only server routes transition status — never a direct client write (see Security below). The pre-existing `escalated` enum value is left in place, unused by this workflow — Postgres can't cheaply drop an enum value, and removing it would be a destructive migration.

## Database changes

**Migrations** (`supabase/migrations/20260814000001` through `...000006`):
1. `dispute_status` enum widened: `evidence`, `under_review`, `closed`, `cancelled` added (isolated ADD-VALUE migration, per this project's rule that adding new enum values must be its own migration, separate from anything that uses them).
2. `disputes` hardened: `title`, `description`, `requested_resolution`, `assigned_admin_id`, `outcome`, `resolved_by`/`resolved_at`, `closed_by`/`closed_at`, `cancelled_by`/`cancelled_at`/`cancellation_reason`, `evidence_requested_by`/`evidence_requested_at`/`evidence_request_note`, `updated_at` + touch trigger. The legacy `"disputes: parties insert"` RLS policy was **dropped**, not extended — dispute creation moved fully to the `open_dispute()` RPC. `disputes` now has **zero client write policies at all**, matching `barter_agreements`' fully RPC-gated model.
3. `messages.dispute_id` (nullable) + `enforce_dispute_message_consistency()` trigger — the one genuinely new trigger in this phase, since "does this message's `dispute_id` actually belong to the same booking/order/barter agreement as the message itself" can't be expressed as a plain CHECK constraint.
4. `dispute_history` — append-only, `actor_role in ('raiser','respondent','admin','system')`. Also defines `is_dispute_participant(dispute_id, user_id)`, a reusable SQL function used by every subsequent RLS policy in this phase instead of repeating the 3-way join through bookings/orders/barter_agreements.
5. `dispute_evidence` + the `dispute-evidence` storage bucket (private, 10MB, `image/jpeg|png|webp` + `application/pdf`), mirroring `barter_offer_media`'s exact shape. No update/delete client policy anywhere — immutable, append-only. Storage RLS compares `id::text` to the path segment (never casts the path segment to `uuid`, which would throw a hard error on malformed input — the same pitfall `barter_offer_media`'s own policies avoid).
6. `open_dispute`, `assign_dispute_to_admin`, `start_dispute_review`, `request_dispute_evidence`, `resolve_dispute`, `close_dispute`, `cancel_dispute` — all `SECURITY DEFINER`, `service_role`-only, idempotency-keyed.

### A bug found and fixed during design, before it ever shipped

Migration 5's storage RLS was first drafted casting the URL path segment directly to `uuid` via `is_dispute_participant((storage.foldername(name))[1]::uuid, auth.uid())`. That throws a hard Postgres error on any malformed/arbitrary path segment rather than just failing the policy — caught by comparing against `barter_offer_media`'s own established (safer) pattern before applying the migration, and rewritten to compare `d.id::text = (storage.foldername(name))[1]` instead. Never reached the live database in the broken form.

### `outcome` values are generic, not literal "merchant_wins"/"customer_wins"

Barter has no merchant/customer distinction — two peer parties. `outcome` stores `favor_raiser | favor_respondent | mutual_agreement | manual_settlement`; `getDisputeOutcomeLabel()` (`src/lib/disputes/status-labels.ts`) maps `favor_respondent` → "Merchant wins" / `favor_raiser` → "Customer wins" for booking/order UI copy, and renders the same two values in party-neutral language when no domain framing is supplied (barter). One schema, domain-appropriate display labels — never needs a second migration to fix this for barter.

## RPCs

| RPC | Transition | Who |
|---|---|---|
| `open_dispute` | (none) → `open` | The raiser — validated server-side as a real party to the referenced booking/order/barter agreement, never trusted from the client. Also sets the referenced transaction's own status to `'disputed'` (a value all three enums already had) and rejects if a non-terminal dispute already exists for that transaction. |
| `assign_dispute_to_admin` | status unchanged | Admin, assigns to another (or the same) admin |
| `start_dispute_review` | `open`/`evidence` → `under_review` | Admin |
| `request_dispute_evidence` | `open`/`under_review` → `evidence` | Admin |
| `resolve_dispute` | `under_review` → `resolved` | Admin, records `outcome` + `resolution_notes` |
| `close_dispute` | `resolved` → `closed` | Admin |
| `cancel_dispute` | any non-terminal → `cancelled` | Admin only, per the brief's Part H — not participant-initiated |

`resolve_dispute`/`close_dispute`/`cancel_dispute` don't re-verify the caller's admin role inside the RPC itself — matching every existing admin RPC in this codebase (e.g. `decide_moderation`), the real boundary is the Next.js route's `requireAdminForRoute()` gate, the only way to reach these `service_role`-only functions at all.

## Routes

Participant: `POST/GET /api/disputes` (open / list own), `GET /api/disputes/[id]`, `POST /api/disputes/[id]/evidence` (registers an already-uploaded file, mirrors `src/app/api/barter/[id]/media/route.ts`'s re-validation pattern — path-prefix check, party re-check — with idempotency added at the route level, which barter's own media route doesn't have), `GET/POST /api/disputes/[id]/messages`.

Admin: `GET /api/admin/disputes` (+CSV), `GET /api/admin/disputes/[id]`, `POST /api/admin/disputes/[id]/{assign,start-review,request-evidence,resolve,close,cancel}`.

## Messaging

Reuses `messages` entirely — no new chat system. A dispute message is tagged with `dispute_id` in addition to whichever of `booking_id`/`order_id`/`barter_agreement_id` it already carries (the 3-way exactly-one-of CHECK from Phase 1 is untouched). Since general transaction chat doesn't exist yet (Phase 3 hasn't shipped), **dispute chat is the first real use of the `messages` table** — and the first real server-side enforcement point for `filterMessage()` anywhere in the app (previously only ever called by the mock chat UI's local state). A filtered message is still inserted (`is_filtered=true`), never silently dropped, matching those columns' existing intent. Realtime works automatically — `messages` was already added to the `supabase_realtime` publication in Phase 1.

## Evidence

Participants upload images or PDFs directly to the private `dispute-evidence` bucket client-side (RLS-gated, `{dispute_id}/{uploader_uid}/{filename}`), then this route registers the row after re-validating everything server-side (path-prefix ownership, dispute is still active, caller is really a participant via `is_dispute_participant()`). Immutable, append-only — no update/delete policy for any client role, ever.

## Admin workflow

`src/lib/admin/disputes-service.ts` mirrors `operations-service.ts`'s exact shape (one base query + `Promise.all` of related rows + in-memory joins). Real `/admin/disputes` (list, filters, CSV) and `/admin/disputes/[id]` (full detail + action panel) replace the old stub. One new exception category, `dispute_open_too_long` (open/evidence/under_review past 48h, same threshold as every other exceptions-service category), extends `ExceptionEntityType` with `'dispute'`.

## Emails

8 new catalogue entries (`src/lib/email/templates/catalogue.ts`), no new files, no provider changes: `dispute-opened-raiser` / `dispute-opened-respondent` (2 templates — wording genuinely differs, matching how `booking.requested` already splits), plus one shared template each for `evidence_requested`, `evidence_received`, `under_review`, `resolved`, `closed`, `cancelled` (sent to both parties — content doesn't need personalizing per side). Since `email_deliveries.related_entity_type` has no `'dispute'` value (only `booking|listing|identity_verification|order|barter_agreement`, widened in Phase 1) and every dispute maps 1:1 to exactly one transaction, dispute emails reference that underlying transaction directly rather than needing yet another schema widening.

## Security

- RLS (`is_dispute_participant()`-backed) blocks non-participant read on `disputes`, `dispute_history`, `dispute_evidence`.
- The evidence-registration route re-checks participancy server-side independent of RLS (same defense-in-depth as barter's media route).
- `open_dispute()` validates the raiser is a real party to the referenced transaction before ever inserting a row.
- `resolve_dispute`/`close_dispute`/`cancel_dispute` are only reachable through admin-gated routes — the RPCs themselves are `service_role`-only and unreachable by any client directly.
- Zero client write policies remain on `disputes` after this phase — every mutation is RPC/route-mediated.
- Live-verified (31 checks, see below): a non-participant gets 404 on detail/messages (RLS makes a non-party row indistinguishable from a nonexistent one), 403 on evidence registration, empty results on a direct `dispute_history` read; a non-admin gets 401 on every admin action route; a forged evidence path (someone else's uid) is rejected; a two-FK malformed row is rejected by the database CHECK regardless of role.

## Idempotency

Every RPC and the evidence-registration route use `checkIdempotentReplay()` against the same `idempotency_keys` table every other domain uses. All 7 hash functions (`src/lib/disputes/idempotency.ts`) were cross-checked against real Postgres `md5()` output via a live query before being written into tests, per this project's established discipline — no hand-computed expected values.

## Live validation performed

31 checks against the dev Supabase project + dev server, using real QA accounts across all three transaction types (a live `active` booking, a live `delivered` order, a live `accepted` barter agreement — all with known credentials): opening a dispute on each and confirming the underlying transaction flips to `disputed`; confirming `cancel_booking`/`cancel_barter_agreement` correctly reject the now-disputed transaction without any change to those RPCs (see Known limitations); duplicate-open rejection; idempotent replay consistency; the full non-participant security sweep above; a real respondent's access working correctly; real evidence upload + registration + forged-path rejection; real chat send + filtered-message flagging; the complete admin workflow (list → detail → assign → start-review → resolve → close) on one dispute with the full expected history event sequence confirmed; admin cancel on a second dispute; a malformed exact-one-of row rejected at the database level regardless of role.

### Permanent regression coverage: `scripts/verify-dispute-locking.mjs`

Added after review feedback that live-validation-once isn't the same as durable regression coverage, since later phases (barter financials, payouts) will inevitably touch the same accept/cancel/ship/return-style RPCs the freeze depends on. This is a real script against the live dev database, not a mocked vitest test — consistent with this codebase's established discipline of never mocking Supabase RPC/RLS behavior in a unit test. It creates one dedicated, permanent fixture transaction per domain (booking/order/barter), opens a dispute on each, and asserts every other mutating action is rejected. Safely re-runnable: fixed idempotency keys mean a second run replays the same fixtures rather than duplicating them, and re-verifies the lock still holds rather than erroring. Confirmed re-runnable twice in a row with identical results before being committed.

**This script caught a real, pre-existing bug on its first run**: `cancel_order` used a *blocklist* (`status = 'shipped' or 'delivered' or 'cancelled'`) rather than the allow-list/exact-match style every other cancel-style RPC in this codebase uses (`cancel_booking`, `cancel_barter_agreement`) — `'disputed'` was never in that blocklist, so a disputed order could still be cancelled, silently restoring stock and overwriting the disputed status. This predates Phase 2 (written during the Orders phase, before disputes existed) but was a live, real gap in the freeze this phase depends on. Fixed via `supabase/migrations/20260814000007_order_cancel_dispute_guard.sql` (one new guard clause, `CREATE OR REPLACE`, everything else byte-identical to the live function). The one test order corrupted by the bug during the first script run was manually repaired (status restored to `disputed`, stock re-decremented) — its `order_history` retains an honest, immutable `order_cancelled` record of the bug's effect, since that table can't be altered even by service role.

## Known limitations

**No cross-domain freeze enforcement beyond what already existed.** `open_dispute()` sets the underlying transaction's status to `'disputed'`, but no other domain RPC (`accept_booking_request`, `mark_order_shipped`, `confirm_barter_completion`, etc.) was modified to add a "reject if a dispute is open" guard. This wasn't needed: those RPCs already use exact-match/allow-list status guards (verified live before writing any migration — `cancel_barter_agreement` already explicitly rejects `status='disputed'`, and `cancel_booking`/`mark_order_shipped` use single-value equality checks that exclude `'disputed'` by construction), so the freeze is achieved without touching ~15 existing, proven RPCs across three domains.

**Resolving/closing/cancelling a dispute does not auto-revert the underlying transaction's status.** A booking, order, or barter agreement that enters `disputed` stays `disputed` even after its dispute reaches `closed`/`cancelled` — live-verified directly (see above). Deciding what a transaction should become after a resolved dispute depends on outcome-driven financial execution that's explicitly out of scope for this phase ("no financial execution, only record the outcome" — Part F). This is the single biggest scope boundary in this phase, and reversing it later will need a real design decision (per-domain, per-outcome), not just a follow-up migration.

**`evidence_urls`/`resolution_notes`** on `disputes` are legacy columns from before this phase — `evidence_urls` is superseded by `dispute_evidence` but not removed (never written to going forward); `resolution_notes` is reused as-is for the admin's final resolution text.

**No admin surface exists yet for orders or barter beyond disputes.** This phase only builds the disputes admin queue — Orders Administration and Barter Phase C (their own admin surfaces) are separate, later phases in the Step 11 roadmap.

## Future payment integration

When outcome-driven financial execution is eventually built, the natural integration point is `resolve_dispute()`'s `outcome` value: `favor_raiser`/`favor_respondent` would drive a deposit/cash-adjustment release or forfeiture via the existing `transition_payment_status()` state machine (the same one bookings/barter already use), and `mutual_agreement`/`manual_settlement` would need an explicit admin-entered settlement amount. That work — and the accompanying decision about what status a resolved transaction should revert to — is deliberately deferred, not designed here.
