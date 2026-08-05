# Barter Execution (Step 11 Phase 4)

## What existed before this phase

Barter Phase A shipped listing/offer negotiation only — propose, counter, accept, reject, cancel. `barter_offers` already captured the full financial shape of a trade at negotiation time (`deposit_required`/`deposit_amount`/`deposit_payer`, `cash_adjustment_amount`/`cash_adjustment_payer`), and `barter_confirmations` already existed as a schema (unique per agreement+party, "completion only occurs once both rows exist") — but nothing ever wrote to it. `accept_barter_offer()`'s and `cancel_barter_agreement()`'s own Phase A header comments explicitly anticipated being revised once payments existed. This phase is that revision, plus everything after acceptance that Phase A deliberately left out: paying deposits, settling the cash difference, tracking physical-exchange progress, and dual-confirmation completion.

## Architecture

**No new payment architecture.** Every financial operation in this phase is a thin, agreement-scoped wrapper around the exact same generic building blocks bookings and orders already use: the `PaymentProvider` interface (`authorizeDeposit`/`releaseDeposit`/`chargeRental`), the generic RPCs (`transition_payment_status`, `record_payment_attempt`, `capture_deposit_amount`), and the `payments` table itself (now widened with a nullable `barter_agreement_id`). Barter's financial pieces (0–2 deposits + 0–1 cash adjustment) are each independent single-provider-call operations — they follow the **order** pattern (`chargeOrderPayment`'s single-step shape), not the booking pattern (`authorizeBookingFinancials`'s multi-step, `financial_workflows`-backed resumable shape) — a barter deposit is never part of a combined multi-step workflow the way a booking's rental-charge-then-deposit sequence is, so no new workflow table exists.

## Lifecycle

The brief's suggested state names (Deposit Pending → Ready → In Progress → Completion Pending) map onto `barter_status`'s **existing** enum values — no enum migration was needed:

| Suggested name | Actual status | Meaning |
|---|---|---|
| Accepted | `accepted` | Offer accepted; 0–3 payment intents created atomically with acceptance |
| Deposit Pending | `accepted` (derived) | Same status — financial readiness is a *derived* value (`deriveBarterFinancialReadiness()`), never a separate status, mirroring how booking's `financiallyReady` flag works |
| Ready | `preparing` | Reached only once every required deposit is authorised and any cash adjustment is captured |
| In Progress | `in_transit` | Only reachable when the accepted offer's `delivery_method = 'courier'` — meet-in-person/self-collection/other skip this leg entirely |
| Completion Pending | `awaiting_confirmation` | Physical exchange has happened; waiting on `barter_confirmations` |
| Completed | `completed` | Both parties confirmed |

Side exits: `cancelled`, `expired` (Phase A), `disputed` (Phase 2, reused as-is).

`mark_barter_progress(actor, agreement_id, target_status)` is one flexible RPC, not three — it validates only these transitions: `accepted → preparing` (gated on financial readiness, checked inside the RPC itself), `preparing → in_transit` (courier only), `preparing → awaiting_confirmation` (non-courier only), `in_transit → awaiting_confirmation`. Either party may call it — unlike accept/reject, progress isn't adversarial.

## Financial model

`accept_barter_offer()` was revised to additionally create (never authorise) 0–3 payment intents from the just-accepted offer's own terms, in the same transaction as acceptance — a plain DB insert (`create_barter_payment_intent()`, mirrors `create_order_payment_intent()`), no provider call, so folding it into acceptance is safe. Authorising a deposit or charging the cash adjustment is a separate, explicit, **payer-initiated** action (`POST /api/barter/[id]/deposit`, `.../cash-adjustment`) — acceptance never auto-charges anyone, mirroring how booking acceptance never itself triggers payment.

`payments.barter_agreement_id` (nullable, 3-way exactly-one-of CHECK with `booking_id`/`order_id`) and two new `payment_type` values (`barter_deposit`, `barter_cash_adjustment`) were added. The uniqueness constraint is **not** the plain `(barter_agreement_id, payment_type)` shape orders got — it's `(barter_agreement_id, payment_type, renter_id)`, because a two-sided deposit genuinely needs two `barter_deposit` rows for the same agreement (one per payer). `renter_id`/`merchant_id` are repurposed as generic payer/counterparty ids, the same repurposing precedent orders already established for buyer/seller.

## Deposits

`deposit_payer ∈ {'party_a', 'party_b', 'both'}` (already established in Phase A) directly supports no-deposit (`deposit_required = false`), one-sided, and two-sided deposits — no new data model. `authorizeBarterDeposit()` (`src/lib/payments/orchestrator/authorize-barter-deposit.ts`) mirrors `ensureDepositAuthorised`'s inline shape from `authorize-booking-financials.ts`, but as its own top-level export: a single provider call needs no `financial_workflows` row, the same reasoning `releaseDeposit()`/`captureDeposit()` already establish. `releaseBarterDeposit()` mirrors `release-deposit.ts` exactly, scoped by agreement + payer.

**Bug found and fixed during live regression testing**: both `authorizeBarterDeposit()` and `chargeBarterCashAdjustment()` originally checked the agreement's own status (`must be 'accepted'`) *before* checking whether the specific payment had already succeeded. This meant a legitimate retry of an already-successful payment — the exact case a fixed idempotency key exists to handle — would incorrectly fail with "not eligible" once the agreement had progressed past `accepted` (which happens precisely *because* the payment succeeded). Fixed by reordering both functions to check the payment's own already-done status first, mirroring how `releaseDeposit()` and `chargeOrderPayment()` already do this. Confirmed live via `scripts/verify-barter-execution.mjs` re-runs.

## Cash adjustment

`cash_adjustment_payer` (a uuid FK to `profiles`) plus `cash_adjustment_amount` directly express none/party-A-pays-B/party-B-pays-A — again, no new data model, just executing on what Phase A already captured. `chargeBarterCashAdjustment()` mirrors `chargeOrderPayment()` exactly, reusing `provider.chargeRental()` (no separate provider method — functionally identical to a one-time charge, the same reuse precedent orders already established). Unlike an order, there's no "mark paid" RPC step afterward — capturing the cash adjustment doesn't itself move `barter_agreements.status`; that's `mark_barter_progress`/`confirm_barter_completion`'s concern.

**A second instance of the same eligibility-ordering bug was caught and fixed here too** — `chargeBarterCashAdjustment()` originally had *no* agreement-status eligibility check at all, meaning a disputed or cancelled agreement's still-`pending` cash-adjustment intent could technically still be charged, which would have violated "opening a dispute freezes financial progression." Fixed by adding the same `ELIGIBLE_AGREEMENT_STATUSES = ['accepted']` guard `authorizeBarterDeposit()` already had, ordered correctly (already-captured check first, then eligibility).

## Completion

`confirm_barter_completion(actor, agreement_id, note)` inserts into `barter_confirmations` (`on conflict (agreement_id, party_id) do nothing` — a second confirmation from the same party is a harmless no-op) and only flips `status = 'completed'` once both rows exist. A single confirmation leaves the agreement at `awaiting_confirmation` — **no automatic completion from one side**, verified live. Only when the RPC reports `'completed'` does the route separately call `releaseBarterDeposit()` for every `'authorised'` deposit (money movement stays in JS, never inside the SQL RPC — see "Deviation from the Phase A plan" below). A successful trade **releases** deposits, it never captures/forfeits them — see Known Limitations.

## Cancellation

`cancel_barter_agreement()` (Phase A, **untouched** by this phase) already computes `cancellation_settlement` descriptively: `not_applicable` (pre-acceptance), `refunded` (accepted/preparing), `frozen_pending_dispute` (in_transit/awaiting_confirmation, or disputed for the admin-privileged sibling). This phase makes `refunded` actually move money.

### Deviation from the Phase A plan

`cancel_barter_agreement`'s own Phase A comment anticipated being `CREATE OR REPLACE`d in this phase "to add the actual `transition_payment_status()` loop" *inside the RPC*. That would call a payment-status-changing RPC without ever going through `PaymentProvider` first — no other code path in this codebase moves real payment status without a provider call preceding it (release/capture are always provider-first). Doing it here would have been a real regression in provider-neutrality for the sake of matching a stale comment. Instead: `cancel_barter_agreement` is **left completely unchanged**, and the **route layer**, after reading back its `settlement` value, does the money movement in JS — exactly the same split every other cancellation-adjacent financial action in this codebase already uses (RPC decides status/labels, JS orchestrates the actual provider call afterward). `settlement = 'refunded'` releases every `'authorised'` deposit via the orchestrator and directly voids (via the existing generic `transition_payment_status` RPC — no provider call, since nothing was ever authorized for a still-`'pending'` row) any never-attempted cash-adjustment intent. `settlement = 'frozen_pending_dispute'` triggers no financial action at all, matching "refunds (record only where already supported)."

## Disputes

Zero new dispute logic. Phase 2's generic dispute system already covers barter as one of its three transaction types. The only new work: every RPC this phase adds (`mark_barter_progress`, `confirm_barter_completion`, and — at the orchestrator level — `authorizeBarterDeposit`/`chargeBarterCashAdjustment`) checks `status = 'disputed'`/`admin_hold` first, the same guard `cancel_barter_agreement` already had. Verified live: opening a dispute freezes progress, completion, and both payment types; a participant still cannot cancel a disputed agreement (unchanged Phase 2 behavior); an admin *can* cancel a disputed agreement via the new admin-privileged `admin_cancel_barter_agreement()` (settlement always `frozen_pending_dispute` in that branch) — an admin resolving a dispute needs this, a participant bypassing the freeze does not.

## Chat integration

Zero new work. Phase 3's generic chat already covers barter as one of its three transaction types; the "Message" link was already wired into `barter-actions.tsx` in Phase 3.

## Emails

Six new catalogue entries, not seven: `barter-accepted`, `barter-deposit-required`, `barter-ready-to-exchange`, `barter-completion-requested`, `barter-completed`, `barter-cancelled`. **No `barter.disputed` event** — Phase 2's `dispute.opened` already fires for any transaction type including barter the moment a dispute opens; adding a second "your barter was disputed" email would be exactly the overlapping-email pattern `docs/TRANSACTIONAL_EMAILS.md` already documents avoiding. `barter-deposit-required` is sent only to actual deposit payers (not cash-adjustment payers, to keep its wording accurate — a pure cash-adjustment payer sees their obligation on the trade page itself, no dedicated nudge email this phase). `barter-completion-requested` is sent to the *other* party the moment one side confirms (mirrors `booking.return_initiated`'s "notify the other party" pattern). `src/lib/barter/notify.ts` mirrors `src/lib/disputes/notify.ts`'s shared-template-to-both-parties shape; `loadBarterEmailContext()` mirrors `loadDisputeEmailContext()`.

## Admin

Part J's "cancel, suspend, reopen" absorbed what the original 8-phase roadmap called a separate "Barter Phase C" — the user's Phase 4 brief asked for it now. `admin_hold`/`admin_hold_reason` (columns that have existed on `barter_agreements` since Phase A, checked by every Phase A RPC, but never *set* by anything until now) back suspend/reopen via `admin_set_barter_hold()`. `admin_cancel_barter_agreement()` is a thin admin-privileged sibling of the participant-facing RPC — same settlement logic, `actor_role = 'admin'` in `barter_history`, reachable only through `requireAdminForRoute()`-gated routes, never a client-claimed role. Every admin action is audited via `barter_history` (already supported `actor_role IN ('party_a','party_b','system','admin')` since Phase A — no migration needed there either). A minimal `/admin/barter` list + detail page mirrors `/admin/disputes`'s exact shape (`src/lib/admin/barter-service.ts` mirrors `disputes-service.ts`). No admin "confirm as a party" or "send as a party" path exists anywhere — read/audit/cancel/hold only.

## Security

Every new RPC: participant-or-admin-only, `service_role`-only execution (direct RPC access from a client is impossible), idempotency-keyed via the existing `idempotency_keys` table, amounts always read server-side from the accepted offer/payment row and never accepted as a client parameter, disputed/admin_hold freezes every new mutating surface. Forged agreement ids behave like every other forged id in this codebase — 404, indistinguishable from nonexistent, at both the route and RLS layers. No new client write policy exists on `payments`, `barter_confirmations`, or `barter_history`.

## Live validation performed

Build health: `tsc --noEmit` clean, `eslint` clean, `vitest` 821/821 passing, `next build` succeeded with all new routes present. Manual SSR smoke tests (real QA sessions) confirmed 200 responses with no application errors on the renter barter list/detail pages and the admin barter list/detail pages. All 6 email events confirmed dispatching and `status = 'sent'` live via `email_deliveries`.

### Permanent regression coverage: `scripts/verify-barter-execution.mjs`

Mirrors `verify-dispute-locking.mjs`/`verify-chat-security.mjs`'s exact shape and safety gate — a real script against the live dev database, dedicated `[QA] Phase4-Barter Regression` fixtures, fixed idempotency keys for safe replay. 62 checks covering: no-deposit full lifecycle, one-sided deposit (financial gate + pay + idempotent replay), two-sided deposit (partial-payment gate), cash adjustment both directions, full completion with live deposit release, cancellation pre-acceptance (`not_applicable`) and post-acceptance (`refunded`, deposit actually released live), a disputed agreement freezing every new RPC, an admin cancelling a disputed agreement, forged agreement ids, non-participant access, and admin hold/release-hold with an audited history trail. Confirmed passing twice in a row (62/62) after the fixes below.

**Bugs found and fixed while running this script, before this report was written:**

1. **Real app bug** (documented above under Deposits/Cash adjustment): both payment-orchestrator functions checked agreement eligibility before checking whether the payment itself had already succeeded, incorrectly rejecting legitimate idempotent retries. Fixed in both functions.
2. **Regression-script-only bugs** (not app bugs): the "disputed" scenario's own last step (an admin cancelling the agreement, to test that admins *can* cancel a disputed trade) permanently altered its own fixture's status, making the earlier-in-the-same-scenario "agreement flips to disputed" assertion fail on the *next* run. Fixed by splitting that check into its own disposable fixture, separate from the primary always-safely-re-checkable "stays disputed forever" fixture. Similarly, the admin hold/release-hold scenario used a single fixed idempotency key for a fully reversible hold-then-release cycle — a fixed key across runs replayed the *first* run's now-stale cached response rather than genuinely re-toggling the row. Fixed by using a per-run-unique key for just that reversible pair, matching the same class of fix `verify-dispute-locking.mjs` needed for its own non-determinism bug.

## Known limitations (stated up front)

Deposit **capture/forfeiture** (the losing side of a dispute keeping the other party's deposit) is not built this phase — `capture_deposit_amount` exists and is generic enough to reuse, but no barter-side wrapper or route calls it. A disputed barter's deposits stay `authorised`/frozen until a future phase adds real dispute-driven financial settlement — exactly matching how Phase 2's disputes already freeze *booking* financial resolution the same way. No courier/tracking integration — `in_transit` is a self-reported status, not backed by any shipment-tracking provider, matching the brief's explicit exclusion. `barter-deposit-required` does not also nudge cash-adjustment-only payers by email this phase (they see their obligation on the trade page).

## Future live-payment integration

Nothing in this phase is provider-specific. `authorizeBarterDeposit`/`releaseBarterDeposit`/`chargeBarterCashAdjustment` all go through `getPaymentProvider()` exactly like every booking/order financial function — swapping `PAYMENT_PROVIDER=mock` for a real provider requires no changes to any file this phase touched, the same one-line registry swap every other domain in this codebase already relies on.
