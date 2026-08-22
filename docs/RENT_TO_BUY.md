# Rent-to-Buy (V2)

Rent-to-buy (RTB) = rental-style possession + installment purchase + escrow-governed funds + eventual ownership transfer. **Possession is never the same thing as ownership.** The merchant remains the legal owner of the item until every ownership-transfer condition below is satisfied — never merely because a payment succeeded.

Safe by default: `RENT_TO_BUY_ENABLED` (env var, default unset/false) gates every route that creates something *new* (enabling listing terms, creating a request, accepting a `rent_to_buy` marketplace offer). Disabling the flag never removes access to an existing agreement — every other RTB route (payments, handover, possession, default, return, amendments, termination, admin) stays fully reachable regardless of the flag's value.

## The three status dimensions

`rent_to_buy_agreements` tracks three independent columns, never collapsed into one:

- **`status`** — the overall agreement lifecycle (`pending_merchant_acceptance → awaiting_first_payment → active → completed`, or `defaulted`/`cancelled`/`disputed`).
- **`possession_status`** — has the customer actually taken hold of the item (`not_delivered → possession_eligible → customer_in_possession`, or `return_required → return_in_progress → returned_to_merchant`/`recovered`).
- **`ownership_status`** — who legally owns the item (`merchant_owned` / `customer_owned`). Set **only** by `finalize_rent_to_buy_ownership()` — never derived from `status`, never inferred from a payment event.

The UI (agreement detail, admin detail) surfaces these as separate labels, plus derived payment/escrow/return/deposit status — never one generic "status" string.

## Possession trigger and handover (Rules 4-6)

The merchant configures, per listing, when a customer becomes *eligible* to take possession: `first_payment` / `installment_count` (N instalments paid) / `percentage` (X% of price paid) / `full_payment`. Snapshotted onto the agreement at creation — a later listing-terms edit never rewrites an already-created agreement's trigger.

Reaching the trigger alone is not enough: if the listing has an optional security deposit, the deposit must also be funded before the agreement becomes `possession_eligible` (Rule 12 — full deposit before handover).

Actual possession requires the **real, evidence-backed handover sequence** (reusing `dispute_evidence`'s genuinely-real architecture via the new `rent_to_buy_evidence` table + `rent-to-buy-evidence` storage bucket — never the fake booking pre/post-rental media stub, which has no real backend at all):

1. `possession_eligible` reached (trigger + deposit).
2. Merchant uploads at least one pre-handover condition photo/video, then calls `mark_rent_to_buy_handed_over()`.
3. Customer uploads at least one receipt/condition photo/video, then calls `confirm_rent_to_buy_possession()` — **customer-only**, and the authoritative moment `possession_confirmed_at` is set. This is the only source of truth for when possession genuinely began (never an installment timestamp, never a shipping timestamp).

## Ownership transfer (Rules 7-8)

100%-paid is a distinct event from ownership transfer. When `SUM(paid installments) >= total_purchase_price`, the agreement gets `fully_paid_at` and a 72-hour `completion_window_ends_at` — the UI shows this state as **"FULLY PAID — AWAITING HANDOVER"**, computed from `fully_paid_at` + `ownership_status = merchant_owned`, never a stored enum value.

`finalize_rent_to_buy_ownership()` — system-only, idempotent, the *only* path that can ever set `ownership_status = customer_owned` — requires **all** of: `fully_paid_at` set, `possession_status = customer_in_possession` (genuinely received), `completion_window_ends_at` elapsed, and no unresolved dispute. It is triggered by `POST /api/internal/rent-to-buy/finalize-due-ownership` (secret-authenticated, mirrors `/api/internal/subscriptions/apply-due`'s already-approved pattern) — this is not a default-like automatic termination sweep; it only ever finalizes an outcome that has already been fully earned, re-verified authoritatively inside the RPC itself.

On success: escrow releases the full held purchase amount to the merchant, one `unity_commissions` row and one `merchant_payouts` obligation are created, and the deposit (if any) is refunded.

## Commission (Rule 29-31) — RENTAL rate, never sale, never double

RTB uses the merchant's **rental** commission rate (Starter 12% / Pro 10% / Elite 8%), snapshotted at acceptance — a later subscription change never rewrites an already-accepted agreement. **There is no sale commission for RTB, ever** — this supersedes any earlier placeholder proposing one.

The commission base is the merchant-defined **rental/use rate** applied over the *actual possession period* — never the purchase price:

- Successful completion: possession-confirmed → finalization moment.
- Failed/terminated after possession: possession-confirmed → actual confirmed return (never the agreed return deadline).

Exactly one `unity_commissions` row per agreement (partial unique index on `rent_to_buy_agreement_id`), computed once, at settlement — never per-installment. The old Phase-5 `rent_to_buy_commission_events` table (per-installment, permanently `policy_pending`) is retained for historical/audit purposes only and is no longer written to.

RTB never participates in Affiliate — no attribution, no commission, no placeholder row, even on successful completion.

## Escrow (Rule 33-34)

Each captured installment is escrow-governed exactly like sale/rental (`createEscrowForPayment`/`fundEscrowForPayment`, both no-ops while `ESCROW_ENABLED` is off — fail-closed, never claims real protection when the capability is unavailable). The security **deposit is deliberately not escrow-tracked** — it is a genuinely separate pool (Rule 28), tracked via `deposit_funded_at`/`deposit_forfeited_at`/`deposit_refunded_at` directly on the agreement, so it can never be accidentally swept into a purchase-proceeds settlement.

`_rent_to_buy_settle_escrow()` releases held escrow rows to the merchant up to a computed amount (oldest row first) and refunds every remaining row to the customer — a disclosed simplification of the recovery cap: a row straddling the cap boundary is refunded in full rather than split, so actual recovery can land slightly under the calculated cap but never over it.

## Default (Rules 17-18) — formal, irreversible, never automatic

`initiate_rent_to_buy_default()` (merchant-facing) requires a **live** grace-period check (`now() > overdue installment due_date + grace_period_days`) — computed fresh on every call, never stored, never cron-written. Nothing in this codebase automatically terminates an agreement merely because a cron observes an overdue installment.

Once formally initiated (by the merchant, live-eligibility-gated, or by an admin override), default is **irreversible** — `cure_rent_to_buy_default()` now always rejects, regardless of the `cure_allowed` snapshot (retained as an informational column only). "Catching up" during the grace period is simply paying; the agreement status never left `active` for that case.

- Never possessed: rental/use = R0, no commission, full refund of held purchase escrow, ownership stays merchant's. Settled immediately.
- Possessed: settlement is **deferred** until actual return/recovery confirmation (Rule 26/37 — "only after the outcome is final enough"). Rental/use accrues for the confirmed-possession → actual-return period, capped at held purchase funds, RENTAL commission on the recovered amount, remainder refunded.

## Late return and deposit forfeiture (Rule 22-24)

The return deadline (`return_deadline_at`, merchant-defined `return_window_days` after a return-required event) controls *when a return becomes late* — it never controls when the rental/use period ends. The authoritative rental/use period always runs through the **actual confirmed return**, however late. Failing to return by the deadline forfeits the *full* security deposit — formal default by itself never forfeits it; the trigger is specifically a missed return deadline. Forfeiture never transfers ownership, never becomes purchase balance, never generates Unity commission, and never affects the separately-computed rental/use recovery cap.

## Amendments and mutual termination (Rules 19-21)

Bilateral amendments (`propose_rent_to_buy_amendment` / `respond_rent_to_buy_amendment`) are limited to forward-looking schedule fields (still-`scheduled` installments, grace period, return window) — `total_purchase_price` is never amendable via this path. A proposed schedule must reconcile exactly to the unchanged total.

Mutual early termination requires explicit both-party agreement (`propose_rent_to_buy_mutual_termination` / `accept_rent_to_buy_mutual_termination`, tracked via `rent_to_buy_history` rather than a new table) — no unilateral at-will termination exists. If the customer has possession, the same after-possession settlement economics apply as a default.

## Known limitations / honest gaps

- **No real escrow/payment provider integration** — `ESCROW_PROVIDER=mock` and `PAYMENT_PROVIDER=mock` remain the only functional providers; nothing here claims real licensed money movement.
- **Customer-facing "create RTB request" UI on the listing detail page was not built or found in this phase** — creation currently happens via the marketplace Looking-For/offer flow (`accept_marketplace_offer`'s `rent_to_buy` branch) or a direct API call; a dedicated listing-detail "Request Rent-to-Buy" button with a pre-acceptance terms summary is a genuine gap, not addressed here.
- **72-hour completion/inspection window is a fixed platform constant**, not merchant-configurable (unlike grace/return windows) — matches this codebase's existing fixed-window convention (e.g. booking's 48-hour payment deadline), not a legal claim.
- **`dispute_evidence`'s storage RLS was never widened for RTB dispute participants** — a pre-existing, adjacent gap in the disputes domain, not this domain; `rent_to_buy_evidence` (this phase, handover/return evidence) is an architecturally separate table and unaffected.
