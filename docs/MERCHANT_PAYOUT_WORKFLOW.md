# Merchant Payout Workflow, Admin Operations and Immutable History (Step 11 Phase 8)

## Pre-Phase-8 gaps

`merchant_payouts` (schema + RLS: `20260801000002`/`20260801000003`, Phase 2C) and `create_merchant_payout()` (`20260801000004`) have existed since very early in this project, correct as far as they go, but nothing was ever built on top of them. Two gaps existed, one larger than the original brief assumed:

- **No operational lifecycle at all** — no way to progress a payout past `pending`, no history, no admin actions, no merchant visibility beyond a mock page.
- **No creation trigger existed either.** `createMerchantPayout()` (the orchestrator wrapper with the real amount/eligibility logic, in `src/lib/payments/orchestrator/create-merchant-payout.ts`) was fully built and unit-tested but had **zero call sites anywhere in `src/app/`** — confirmed by exhaustive search before this phase began. The 3 pre-existing live payout rows (all `pending`, owned by a `phase2a-merchant-a` QA fixture account) were created by an ad-hoc manual call during the original Phase 2C build, not by any real user flow.

Both gaps are closed by this phase.

## Existing payout creation, now wired up

`createMerchantPayout()` is now called from `POST /api/bookings/[id]/confirm-return` — the exact moment a booking reaches `completed` — as a best-effort call after the RPC succeeds, wrapped in its own `try/catch`, never blocking the return confirmation itself. This mirrors the identical pattern already used for affiliate commission qualification in Phase 7.

**A payout creation failure at this point is recovered by `POST /api/internal/payouts/reconcile-missing`** (see "Reconciliation" below), not by the merchant retrying the confirm-return call.

## Booking-only scope, confirmed

Merchant payouts remain strictly booking-scoped. Order seller payouts, barter, affiliate commissions, and services payouts are all explicitly out of scope and untouched by this phase — Phase 6 already established order payout status as `not_applicable`, and affiliate commissions have their own fully independent Phase 7 lifecycle (`affiliate_commissions`, never `merchant_payouts`).

## Payout amount source

Preserved exactly as it existed before this phase — not redesigned. `createMerchantPayout()` derives the amount entirely from that booking's own `ledger_entries` (immutable, already-recorded amounts, never a client-supplied figure or a live recalculation): `payableAmount = rental_charge − platform_fee − refunded`. `platform_fee` is currently always 0 (no fee model exists yet, matching `docs/FINANCIAL_ORCHESTRATION.md`). The deposit is structurally excluded — it is a separate `payment_type` and never appears in the `rental_charge` ledger sum, not filtered out by a runtime check.

## Lifecycle

Preserved `payout_status` exactly: `pending, processing, paid, failed` (unchanged from the original Phase 2C enum — no new values were needed or added).

```
pending → processing → paid
              ↓
           failed → processing (retry)
```

`paid` is terminal. No other transition is permitted — `pending → paid`, `pending → failed`, `failed → paid`, and every transition out of `paid` are all structurally rejected (the RPC's own allowed-from-status array never includes them).

## Transition rules and status definitions

- **PENDING** — a payout obligation exists, not yet started, may be blocked by dispute/refund/restriction.
- **PROCESSING** — an authorised payout attempt has begun. In this environment this is an operational state only — no automated provider is connected, no bank transfer occurs.
- **PAID** — confirmed by an authorised admin recording a legitimate manual payout (no real provider exists yet). Includes `paid_at`, `paid_by`, a safe payout reference, immutable history.
- **FAILED** — a payout attempt did not complete. A normalized, safe failure category is recorded; raw internal/provider text is never exposed to merchants.

## RPCs

Four narrow operations plus a shared internal transition helper, mirroring `_affiliate_commission_transition()`'s exact shape from Phase 7 (locks the row `FOR UPDATE`, validates the allowed-from-status array, captures `previous_status` from the initial lock read — not a post-update re-query, the exact ordering bug class caught and fixed in Phase 7 — writes one history row):

- `mark_payout_processing(p_admin_id, p_payout_id, p_reason, p_idempotency_key)` — `pending → processing`. Full eligibility re-validated.
- `retry_payout(p_admin_id, p_payout_id, p_reason, p_idempotency_key)` — `failed → processing`, same row, never a new one. Reason mandatory. Full eligibility re-validated.
- `mark_payout_paid(p_admin_id, p_payout_id, p_payout_reference, p_payout_method, p_confirm_manual_payment, p_reason, p_idempotency_key)` — `processing → paid`. Requires `p_confirm_manual_payment = true`, a non-empty reference, and `p_payout_method IN ('manual', 'mock_validation')`. Only rechecks conditions that could have newly appeared (dispute/refund/chargeback/restriction) — not the full creation-time eligibility, which doesn't change once already processing.
- `mark_payout_failed(p_admin_id, p_payout_id, p_failure_category, p_reason, p_idempotency_key)` — `processing → failed`. **Deliberately does not gate on positive eligibility at all** — see "Eligibility differs per transition" below.

All four: `SECURITY DEFINER`, `auth.role() <> 'service_role'` hard-blocked, explicit `p_admin_id` (never `auth.uid()`), idempotency-keyed via the standard `idempotency_keys` check-then-insert wrapper.

### Eligibility differs per transition (a binding review correction, not a uniform check)

`mark_payout_processing` and `retry_payout` both perform the **full** eligibility check (booking `completed`, rental payment `captured`, no unresolved dispute, payment not refunded/chargeback, merchant not suspended/restricted). `mark_payout_paid` rechecks only the subset that could have newly changed since processing began. `mark_payout_failed` **does not gate on eligibility at all** — it only requires current status `processing`, a normalized category, and a reason. This is intentional: `mark_payout_failed` must remain usable *precisely because* something has gone wrong (a refund just appeared, a dispute just opened, the merchant just got restricted) — gating it on positive eligibility would make the exact condition causing the failure also block recording that failure.

## Idempotency and stale-state protection

Every mutation's deterministic identity includes the operation, payout id, and the relevant reason/reference/category — computed identically in TS (`src/lib/payouts/idempotency.ts`) and SQL, matching every other domain's established convention. An exact replay returns the cached result with no duplicate history and no re-incremented `attempt_count`; a changed payload under the same key returns a 409 conflict. Current status is validated inside the same locked read/write as the status change itself — two concurrent admin actions can never both succeed; the loser gets a stable stale-state rejection.

## Disputes

An unresolved dispute (`status not in ('resolved', 'closed', 'cancelled')`, the same convention used everywhere else in this codebase) blocks `pending → processing` and `failed → processing`. It does not delete or auto-fail a pending payout. If a payout is already `paid` when a dispute opens, the paid record is never rewritten — a `merchant_payout_paid_then_disputed` exception surfaces it for admin review instead.

## Refunds and chargebacks

Checked via the booking's own `rental_charge` payment status. For an unpaid payout, a refunded/chargeback source blocks processing (`merchant_payout_source_payment_invalid` exception) rather than silently altering the payout amount. For an already-paid payout, a later refund/chargeback leaves the paid record completely untouched — `merchant_payout_paid_then_refunded` surfaces it; recovery/clawback is explicitly out of scope and left as documented future work.

## Merchant restrictions

Reuses the existing generic `account_status` values (`active | restricted | suspended` — no new payout-specific restriction concept was invented). A suspended/restricted merchant blocks new processing; already-paid history remains fully visible and is never deleted.

## Admin actions

`POST /api/admin/payouts/[id]/{mark-processing,mark-paid,mark-failed,retry}` — one route per action (no generic dispatcher), each `requireAdminForRoute()`-gated, admin id derived server-side, idempotency-key required for safe replay, RPC-only mutation.

## Manual payment recording

`mark_payout_paid` requires an explicit `confirmManualPayment: true` from the client — absent or `false` is rejected server-side, not just hidden in the UI. `payoutMethod` is restricted to the closed set `manual | mock_validation`; the browser cannot submit an arbitrary value. No banking details are ever accepted, stored, or logged.

## Failure categories

Nine normalized categories (`recipient_details_unavailable`, `recipient_details_invalid`, `provider_unavailable`, `provider_declined`, `compliance_review`, `account_restricted`, `source_payment_issue`, `internal_consistency_error`, `other`). **`failure_message_safe` is derived server-side from a fixed category → sentence mapping (`mark_payout_failed`'s own SQL `case` statement, mirrored in `src/lib/payouts/failure-messages.ts` for the admin UI) — never from the admin's own free-text reason.** The admin's reason is stored only in `merchant_payout_history.reason` (admin-visible, never shown to the merchant or included in the merchant email).

## Retry

`failed → processing` only, same row. Mandatory reason. Full eligibility re-checked. `attempt_count` increments. The prior failure's history row is never touched — retry adds a new history row, it does not overwrite the old one.

## Idempotency and history

`merchant_payout_history` is append-only, `prevent_row_mutation()` reused verbatim (the same trigger every other immutable-history table in this codebase uses). Its `payout_id` foreign key uses the default `NO ACTION` (never `CASCADE`) — a payout row can never be deleted in a way that cascade-erases its own history, matching the identical live-tested guarantee already proven for `affiliate_commission_history` in Phase 7.

## RLS

`merchant_payouts` already had exactly the correct end-state before this phase even started: one policy, `"merchant_payouts: own read"` (`merchant_id = auth.uid()`), zero write policies. Nothing needed to change. `merchant_payout_history` ships with RLS enabled and zero client policies — admin access is read-only via a service-role admin route, never exposed to merchants directly, matching `affiliate_commission_history`'s precedent. All four RPCs revoke `public`/`anon`/`authenticated` and grant `service_role` only.

## Admin pages

`/admin/payouts` — real list, search, status/overdue/dispute filters, CSV export. `/admin/payouts/[id]` — PAYOUT / MERCHANT / SOURCE BOOKING / FINANCIALS / DISPUTES / HISTORY / EMAILS / ACTIONS sections, action buttons gated to only the transitions valid for the current status.

## Merchant dashboard

`src/app/(dashboard)/dashboard/merchant/payouts/page.tsx` — previously 100% hardcoded mock data (`MOCK_MERCHANT_BOOKINGS`, `MOCK_PAYOUT_HISTORY`) with a fake, non-functional "Withdraw Funds" button. Replaced with real data from `GET /api/payouts/me`, the exact four status-explanation strings from the approved spec, and no mutation control of any kind — merchants cannot start processing, mark paid, mark failed, or retry.

## Exceptions

14 categories added (`ExceptionEntityType` gained `'merchant_payout'`), computed live and read-only — no sweep ever mutates a payout. `merchant_payout_refund_block` and `merchant_payout_chargeback_block` from the original suggested list were folded into `merchant_payout_source_payment_invalid` (all three describe the same underlying fact — the rental payment is no longer `captured` — so three near-identical categories would be pure noise, matching this project's own "do not duplicate" precedent). `merchant_payout_missing_for_completed_booking` (a binding review correction) flags a completed, eligible booking with no payout row at all.

## CSV export

Safe fields only: payout reference, merchant display name, booking reference, listing title, amount, currency, status, attempt count, timestamps, and the *normalized* failure category (never raw failure text). Reuses the existing shared `toCsv()`/`csvResponse()` helpers, including their formula-injection protection.

## Emails

Five templates (`merchant-payout-created`, `-processing`, `-paid`, `-failed`, `-retry-started`), reusing `loadBookingEmailContext()` rather than a new context loader. Deterministic occurrence keys (the mutation's own idempotency key, never a self-generated timestamp — the exact lesson already learned and fixed for the equivalent affiliate notify helper in Phase 7). Dispatch always happens strictly after the database transition has already committed; an email failure never affects the payout state.

## Reconciliation

Two internal, `INTERNAL_CRON_SECRET`-gated routes:

- **`POST /api/internal/payouts/reconcile`** — read-only detection, reuses `listOperationalExceptions()` (the same live computation the admin exceptions page already runs) filtered to payout categories, rather than duplicating the same detection logic in a second place. Never mutates a payout.
- **`POST /api/internal/payouts/reconcile-missing`** — the recovery path for the best-effort creation hook (a binding review correction). Finds `completed` bookings with a captured rental payment and no existing payout row (any status), calls the *same* `createMerchantPayout()` service used at confirm-return, bounded batch (50), excludes already-resolved bookings at the query level (not just per-row) so it doesn't keep re-scanning the same batch forever as volume grows. Creates at most one payout per booking. Never calls a payout provider.

Neither route is wired to a Vercel cron yet — manual invocation is documented in `docs/PUBLIC_TEST_RUNBOOK.md`.

## Security

Live-tested: a merchant cannot mark their own payout paid or read another merchant's payout; forged payout/merchant/booking/amount/status/reference values are never trusted from the client (every RPC re-derives its own values or rejects an invalid one); a direct, non-service-role authenticated RPC call is blocked; skipping straight from `pending` to `paid`, or from `failed` to `paid`, is rejected; a changed-payload replay under a reused idempotency key conflicts rather than silently applying; direct history `UPDATE`/`DELETE` is blocked at the database level; CSV output excludes every sensitive field and prevents formula injection.

## Future provider webhook seam

The exact seam a future real payout provider (or provider webhook) plugs into: `mark_payout_processing` is where an "authorize with the provider" call would be added; `mark_payout_paid`/`mark_payout_failed` are where a provider's async confirmation/decline webhook would call the equivalent RPC instead of an admin route. No architecture change is required later — only a new caller.

## Known limitations

- No real payout provider — `manual` and `mock_validation` are the only payout methods, both admin-recorded, matching every other financial domain in this codebase at this stage.
- No payout reversal/clawback automation — a paid-then-refunded payout requires manual admin review; automated recovery is explicitly future work.
- No payout batching, multi-currency conversion, or split payouts.
- No seller order payouts, barter payouts, affiliate-payout merging, or services payouts — all remain outside `merchant_payouts` by design.
- No automatic Vercel cron for either internal route — manual/scripted invocation only, matching this codebase's other internal routes at this stage.
