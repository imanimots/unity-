# Unity Commission Framework (Unity Phase 2)

The second of four planned commercial phases. Phase 1 established the Starter/Pro/Elite plan
model and `getEffectiveMerchantPlan()`. Phase 2 makes actual transaction economics consume that
authority — **one trusted commission engine**, never scattered across UI, routes, booking/order
services, payout services, SQL functions, or tests.

## What existed before this phase (Step A findings)

- **A real, live, flat 5% rental "commission" already existed**, hardcoded twice: once in
  `src/lib/payments/calculations.ts`'s `PLATFORM_FEE_RATE = 0.05`, and — the actually-executing
  copy — inline inside `transition_payment_status()` (`round(v_payment.amount * 0.05, 2)`,
  `20260801000004_payment_rpcs.sql`). This directly funded `createMerchantPayout()`'s payout
  arithmetic via a `platform_fee` ledger entry. This is the exact "scattered commission
  calculation" this phase's brief warns against, confirmed live before writing any code.
- **Sales (orders) had no commission-adjacent concept at all** — `transition_payment_status()`'s
  branches never match `payment_type = 'order_payment'`, so zero ledger entries were ever written
  for an order payment. Greenfield.
- **No sale-side merchant payout system exists** (confirmed in Phase 6: `payoutStatus` is always
  `'not_applicable'` for an order). Phase 2 does not invent one — Unity commission still qualifies
  and snapshots correctly for sales, but there is nothing to subtract it from yet. Stated as a
  known limitation, not silently expanded into.
- **Affiliate commissions (Phase 7) already fully qualify independently**, on the same two hook
  points this phase now also uses, with their own snapshot/lifecycle/history architecture. Not
  modified beyond the minimum safe integration required for payout arithmetic (Rule 6).
- **Cancellations never move money themselves** — `cancel_order()`/`cancel_booking()` (read
  directly) only flip status and write history; any actual refund is a separate `create_refund()`
  call. This means Rule 8 (cancellations) is fully subsumed by Rule 7's refund-driven
  reconciliation — no separate cancellation-specific mechanism was needed.
- **Disputes never move money themselves either** — `resolve_dispute()` records an outcome label
  only. Rule 9 is satisfied by holding a commission for the duration of an unresolved dispute and
  re-evaluating it against the payment's actual refund state once the dispute is no longer
  unresolved — never inventing a dispute-specific financial state.

## Architecture

**One authoritative table, `unity_commissions`** — one row per qualifying payment event (mirrors
`affiliate_commissions`'s proven shape), never a booking/order-level aggregate. `unique(payment_id)`
is a database-level guarantee, not just application logic.

**One trusted formula**, `calculateUnityCommission()` (`src/lib/commissions/calculate.ts`), mirrored
in SQL by `_calculate_unity_commission()`. The SQL function is authoritative for money (it's what
the qualification RPCs actually call); the TS copy is unit-tested in isolation and powers
admin/merchant UI previews — the same "non-authoritative mirror" split already established by
`src/lib/affiliate/commission-calc.ts`.

**Plan/rates are never client-suppliable.** Every qualification RPC resolves the merchant's
effective plan itself via Phase 1's `_get_effective_merchant_plan_id()` and reads rates from
`merchant_subscription_plans` — the one authoritative catalogue, never duplicated.

## Rounding

One rule everywhere: convert rands to integer cents (`Math.round(rands * 100)`), apply basis
points via `applyBps()` (`src/lib/money/basis-points.ts`, `Math.round((cents * bps) / 10000)`,
round-half-up), convert back to rands only for display/storage. Mirrored in SQL via Postgres's own
exact-decimal `round(numeric, 2)` — mathematically identical for non-negative 2dp money, so the two
implementations can never silently diverge. Phase 1's `computeMonthlyPlanCost()` was refactored
(behavior-unchanged, re-verified against its existing 15 tests) to use the same shared
`applyBps()` helper, so this really is the *same* helper everywhere, not just the same rule
expressed twice.

## Sales (Rule 1) and high-value sales (Rule 2)

`eligible_base = max(order.total_amount - order.shipping_fee, 0)` — the immutable, seller-funded,
post-discount final price, minus delivery. No deposit/insurance/damage-reimbursement/provider-fee
concept exists on orders to exclude.

Above R100,000, the plan rate applies only to the first R100,000; exactly 1% (fixed, not
plan-dependent) applies to the amount strictly above it, **replacing** — never adding to — the
plan rate on that excess. At exactly R100,000.00 the excess is still 0 ("up to and including").
Verified live and by unit test against every example in the source brief:

| Sale value | Starter | Pro | Elite |
|---|---|---|---|
| R150,000 | R6,500 | — | — |
| R250,000 | R7,500 | R6,500 | R5,500 |
| R500,000 | R10,000 | R9,000 | R8,000 |

## Rentals (Rule 3)

`eligible_base = ` the `rental_charge` payment's own amount — deposit (a different `payment_type`,
structurally excluded) and replacement value are never touched. No high-value excess (Rule 2 is
sale-only). Qualifies once per successful `rental_charge` payment event — a future
extension/recurring-payment feature would produce its own additional commission with zero further
schema changes, matching Phase 7's own established design intent.

## Barter (Rule 4)

**Zero mechanism, not a zero-value row.** No barter orchestrator file (`authorize-barter-deposit.ts`,
`release-barter-deposit.ts`, `charge-barter-cash-adjustment.ts`) references either qualification
RPC — confirmed by a permanent grep-based assertion in the regression script, mirroring the same
technique used for affiliate commissions in Phase 7. `unity_commissions` has no
`barter_agreement_id` column at all; the schema itself makes a barter-linked commission
structurally impossible, not merely unlikely.

## Lifecycle

`pending` → `held` (an unresolved dispute exists) → back to `pending` once resolved → `earned`
(48h review window passed, no refund/dispute found) or `adjusted` (a partial refund reduced the
retained amount) or `voided` (a full refund/effectively-zero-retained cancellation). No payout
sub-lifecycle exists — Unity never "pays itself"; its commission is realized simply by being
excluded from the merchant's payout. The original snapshot row (`eligible_base`, rates, base
splits, `commission_amount`) is **never rewritten** — `unity_commission_adjustments` records
signed deltas; a merchant's effective retained commission is `commission_amount + sum(adjustments)`.

## Refunds and disputes (Rules 7–9)

One reconciliation sweep (`POST /api/internal/commissions/reconcile-refunds`) handles both:

- **Dispute hold/release**: any `pending`/`adjusted` commission whose transaction has an
  unresolved dispute moves to `held`; once no longer unresolved, it's released back to `pending`
  in the same pass, so a dispute that concluded with a refund is reconciled immediately after.
- **Full refund** → `void_unity_commission()`, idempotent (re-running finds nothing left to void).
- **Partial refund** → the eligible base is scaled by the fraction of the payment still
  unrefunded, recomputed **using the commission's own original rate snapshot** (never a live plan
  lookup — Step G's historical-pricing invariant applies here too), and a delta adjustment is
  applied only if it differs from the sum of adjustments already recorded. Retrying against an
  unchanged refund state always computes delta = 0 — idempotent by convergent computation, not by
  idempotency key.

A second sweep, `POST /api/internal/commissions/finalize-earned`, promotes `pending` → `earned`
after the review window with nothing found — purely a reporting confirmation; `earned` and
`pending` are treated identically by payout arithmetic.

## Affiliate integration (Rule 6) and merchant payout integration (Step F)

`createMerchantPayout()`'s formula is now: `rentalCharge - platformFee - affiliateReward - refunded`.
`platformFee` is unchanged in *how* it's read (`ledger_entries` where `entry_type = 'platform_fee'`)
but is now written by `qualify_rental_payment_unity_commission()` (plan-aware) instead of the old
hardcoded 5% inside `transition_payment_status()` — a deliberate separation of concerns: the
generic payment state machine stays commission-domain-agnostic. `affiliateReward` is new: the sum
of that booking's non-voided `affiliate_commissions.commission_amount` — the merchant funds the
affiliate reward they themselves enabled and rate-set on the listing, so it reduces the merchant's
proceeds, not Unity's own commission, exactly matching the brief's conceptual formula. Sales have
no equivalent payout system to integrate into yet (stated limitation above).

## Security

Zero client write policies on `unity_commissions`/`unity_commission_history`/
`unity_commission_adjustments`. Every RPC hard-blocked at the **grant level** for non-service-role
callers (`revoke all ... from public, anon, authenticated`), confirmed live — a direct RPC call
from an authenticated (non-service-role) session fails with `permission denied for function`
before the function body's own `auth.role()` check is ever reached. A merchant reads only their
own commission rows; an admin reads all.

## Checkout wording (Step J)

Audited: no order/buy checkout surface has ever mentioned commission/platform/service fees. One
latent finding on the rental side: `src/lib/bookings/price.ts` has a `platformFeeAmount` field,
always hardcoded to `0`, plumbed through to `payment-breakdown.tsx`'s checkout display (rendered
only when `> 0`, so never actually shown today). This field is a **pre-existing, dead, unrelated**
piece of booking price-quote plumbing — Phase 2 does not touch or activate it. A clarifying comment
was added at its exact definition site recording that it must never be repurposed to carry Unity's
commission, since Unity commission is merchant-funded and must never be added to what a renter is
quoted or charged.

## Admin, merchant UI, emails

Admin: `/admin/commissions` list + detail (hold/release/void/adjust, mirroring the affiliate
admin surface's exact shape), 2 new exception categories (held-overdue, missing-for-completed-transaction),
5 new overview stats. Merchant: `/dashboard/merchant/commissions` — eligible amount, Unity
commission (with the high-value split explained when it applies), affiliate reward where present,
resulting proceeds basis; linked from a new merchant-dashboard quick-link card. 2 new email
templates (`unity-commission-voided`, `unity-commission-adjusted`), reusing the existing email
infrastructure only.

## Source-of-truth: `unity_commissions` vs. `platform_fee` ledger

`unity_commissions` (+ its append-only `unity_commission_adjustments`) is the **single
authoritative** record of what Unity is owed on a payment — a voided commission is R0 owed; any
other status contributes `commission_amount + sum(adjustments)`. `ledger_entries.platform_fee` is
a **write-once legacy projection**, inserted exactly once at qualification time and never updated
by any later hold/release/void/adjustment transition — it exists purely for historical
audit/display continuity, matching every other `ledger_entries` row's role in this codebase. It is
never read for payout arithmetic (see the corrective fix below).

## Corrective verification fix — `createMerchantPayout()` stale-fee bug

A post-implementation corrective pass found and fixed one real bug: `createMerchantPayout()`
originally derived its `platformFee` deduction from the write-once `ledger_entries.platform_fee`
row above. Because that row is never updated, an admin who voids or adjusts a commission **before**
a booking completes — with no refund involved at all — would have had that correction silently
ignored: the payout would still subtract the original, stale commission amount. Live-proven
example: a R900 rental with a R108 (12%) commission, voided by an admin pre-completion (payment
stays `captured` throughout, no refund), previously produced an incorrect R792 payout instead of
the correct R900 (a voided commission means R0 owed to Unity). Fixed by adding
`resolveEffectiveUnityCommission()` to `create-merchant-payout.ts`, which reads `unity_commissions`
(+ adjustments) directly for the specific payment instead of the ledger sum, falling back to the
ledger only when no `unity_commissions` row exists at all (pre-Phase-2 legacy-data safety). The
ordinary no-adjustment path is unaffected (verified byte-for-byte identical). Permanently covered
by Scenario L in `scripts/verify-commissions-phase2.mjs`.

## Known limitations (stated up front)

No sale-side (order) merchant payout system exists to integrate Unity commission into — sales
still qualify and snapshot correctly, but there's nothing to subtract from yet. No automated
dispute financial-outcome execution exists anywhere in this codebase (pre-existing, not a Phase 2
gap) — a dispute's resolution is a status label; Phase 2's hold/release only reacts to that label
and to actual refund events, never invents a financial outcome from a dispute alone. No refund
*completion* route/webhook exists yet (`refunds.status` has no application-level path from
`pending` to `completed`) — the regression script's own fixtures use a direct service-role update
as the documented fallback, exactly mirroring the established precedent for backdating a
booking's rental window. Paid rental extensions/renewals are not implemented in the current
product, so no Phase 2 integration point exists yet — when introduced, each successful eligible
rental-payment event must use the same commission qualification engine.

### High-priority cross-domain follow-up (not a Phase 2 defect — do not fix here)

**Resolved-dispute / booking-status bug.** A resolved dispute never reverts a booking's own
`status` column from `disputed` back to `completed` — confirmed live: `booking.status` stays
`disputed` even after the linked dispute row's own `status` becomes `resolved`. Because Phase 8's
`mark_payout_processing` requires `booking.status = 'completed'`, this **permanently blocks
merchant payout processing** for that booking, even when the dispute resolved cleanly with zero
refund involved (confirmed live via a 422 retry after resolution). This spans the pre-existing
Disputes system (which deliberately never auto-reverts transaction status after resolution, per
that phase's own documented scope boundary) and Phase 8 (merchant payout eligibility gating) —
neither of which is Phase 2 Commission Framework's own code. **Not fixed here.** This is a
high-priority follow-up that should be addressed after Phase 2 is pushed and before Phase 3
(Escrow) begins.

## Tests

Unit: `src/lib/commissions/__tests__/{calculate,idempotency,rpc-errors}.test.ts`,
`src/lib/money/__tests__/basis-points.test.ts` (35 tests: every plan rate, every boundary value
from the source brief, all three exact high-value examples, rental-never-has-excess, rounding).
Live: `scripts/verify-commissions-phase2.mjs` — plan-aware rental/sale commissions, exact
high-value math, deposit exclusion, barter structural exclusion, affiliate+Unity coexistence with
payout integration, full and partial refunds (with idempotent-retry proof), dispute hold/release,
qualification idempotency, forged-RPC/direct-write/cross-tenant-read security checks, admin
read/history — run twice consecutively against the live dev database.
