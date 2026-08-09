# Escrow Architecture (Phase 3)

Provider-neutral escrow/secure-transaction architecture for sales, rentals, and barter cash adjustments. **TradeSafe is a proposed provider only — there is no live TradeSafe integration anywhere in this codebase.** `UnsupportedTradeSafeProvider` throws `EscrowNotImplementedError` on every method, exactly like `PeachPaymentsProvider` does for real payments. Only `MockEscrowProvider` (deterministic, no network call, no real money) is functional today.

Safe by default: `ESCROW_ENABLED` (env var, default unset/false) gates the entire domain. While it is not the literal string `"true"`, no escrow transaction is ever created and every existing payment/commission/payout/dispute flow is byte-identical to before this phase existed — the orchestrator functions early-return `null` rather than requiring call sites to branch.

## Responsibility boundary

Escrow is a distinct financial concern from `PaymentProvider` (`src/lib/payments/`): a payment provider processes a charge; an escrow provider holds already-captured funds in custody and later releases or refunds them. `escrow_transactions` is a **wrapper** around an existing `payments` row (`payment_id`, unique), never a replacement for it — the payment record remains the authoritative record of the charge itself.

Escrow never recalculates or duplicates:
- **Unity commission** (Phase 2, `unity_commissions`) — untouched, still the sole authority for platform commission.
- **Affiliate commission** (Phase 7, `affiliate_commissions`) — untouched.
- **Merchant payout** (Phase 8, `merchant_payouts`) — untouched; escrow release and merchant payout are two independent, parallel best-effort steps that both fire from the same completion hook (e.g. `confirm-return`), neither depends on the other.

`escrow_transactions.principal_amount` is always the underlying payment's own `amount` (the full captured charge) — never a commission-adjusted figure. `secure_transaction_fee_amount` is a separate, independent figure (what an escrow provider would charge to hold funds), never summed into `principal_amount` or into Unity commission. With `MockEscrowProvider`, this fee is always `0`.

## Schema (additive only)

- **`escrow_transactions`** — `transaction_type` (`sale`/`rental`/`barter`), a 3-way exactly-one-of `order_id`/`booking_id`/`barter_agreement_id` (mirrors `payments`/`messages`/`disputes`), `payment_id` (unique FK), `status` (`escrow_status` enum: `pending → funded → released` or `refunded`/`partially_refunded` or `cancelled`/`failed`), `principal_amount`, `secure_transaction_fee_amount`, `currency`, `released_to`, `refunded_amount`, timestamps, `version`, `metadata`. Zero client write policies — every mutation goes through a `SECURITY DEFINER`, service-role-only RPC.
- **`escrow_transaction_history`** — append-only (`prevent_row_mutation()`), one row per transition, mirrors `merchant_payout_history`/`dispute_history`.
- **`escrow_provider_events`** — webhook audit/dedup, `unique(provider, provider_event_id)`, mirrors `payment_webhook_events` exactly. A **separate** table from the payments one — escrow is a genuinely distinct concern.

No new status is invented for "disputed" or "held" — release checks the **same** dispute signal every other domain already uses (`bookings.status = 'disputed'` / an unresolved `disputes` row), via `_escrow_transaction_dispute_block()`.

## RPCs

`create_escrow_transaction` / `mark_escrow_funded` — system-only (called from the JS orchestrator right after the underlying payment intent is created / captured), naturally idempotent via `unique(payment_id)` and a status-based no-op check — no `idempotency_keys` row needed since the caller has no real user-facing actor id.

`release_escrow_transaction` / `refund_escrow_transaction` / `cancel_escrow_transaction` — reachable from both the orchestrator (system actor, at the transaction's own completion point) and narrow admin override routes (admin actor, reason required), both idempotency-keyed via the standard `idempotency_keys` pattern. `release` is blocked while the underlying transaction has an unresolved dispute; `refund` is **not** blocked (returning money to the payer is the safe direction); `cancel` only ever applies to a never-funded (`pending`) row.

`_escrow_transaction_transition()` mirrors `_merchant_payout_transition()`'s exact shape: lock `FOR UPDATE`, validate the allowed-from-status array, capture `previous_status` from the initial lock read, write one history row, return the updated row.

## Provider abstraction

`src/lib/escrow/provider.ts` (`EscrowProvider` interface, `EscrowProviderCapabilities` flags) mirrors `src/lib/payments/provider.ts` exactly, including the generic `headers: Record<string, string | null>` webhook-verification shape (a real provider may need multiple differently-named headers). `src/lib/escrow/registry.ts` mirrors `src/lib/payments/registry.ts` (`getEscrowProvider(name?)`, env var `ESCROW_PROVIDER`, default `mock`).

## Integration points wired in this phase

- **Sale**: `charge-order-payment.ts` creates + funds escrow right after the order payment captures. `confirm-delivery/route.ts` releases to the seller.
- **Rental**: `authorize-booking-financials.ts` creates + funds escrow right after the `rental_charge` payment captures (deposits are excluded — a different, non-custodial payment type). `confirm-return/route.ts` releases to the merchant.
- **Barter**: `charge-barter-cash-adjustment.ts` creates + funds escrow for the cash-adjustment payment (barter's only cash leg — a pure item-for-item trade has no payment to escrow, by design, not a gap). `confirm-completion/route.ts` releases to the counterparty.

Every hook is best-effort (wrapped in try/catch, logged, never re-thrown) — an escrow failure never blocks or fails the underlying payment/booking/order/barter flow it's attached to.

## Webhook intake

`POST /api/escrow/webhooks/[provider]` mirrors `POST /api/payments/webhooks/[provider]` exactly: provider isolated via the URL segment, signature verified via that provider's `verifyWebhook()` before any content is trusted, every event recorded (valid or not) via `record_escrow_webhook_event()`, duplicate events return `200 duplicate_ignored` without reprocessing. Returns `503` while `ESCROW_ENABLED` is not `true`.

## Admin surface

Read-only monitoring (`GET /api/admin/escrow`, `GET /api/admin/escrow/[id]`, `/admin/escrow` + `/admin/escrow/[id]`) plus 3 narrow, reason-required override routes (`release`, `refund`, `cancel`) — no generic mutation endpoint. Nothing in the admin UI or API ever names TradeSafe or implies a live provider integration.

## User-facing language

No page anywhere uses "Powered by TradeSafe", "TradeSafe Protected", "Funds held by TradeSafe", or "TradeSafe escrow enabled" — confirmed via a repo-wide grep. The one new email (`escrow-transaction-released`) and the admin UI use generic "secure transaction" / "held in trust" language only.

## Known limitations

- No retroactive escrow history for pre-Phase-3 transactions — only new transactions created after this ships (and only while `ESCROW_ENABLED=true`) get an escrow row.
- `refundEscrowTransaction()` is admin-only in this phase — there is no automatic refund trigger, because the generic `create_refund` RPC itself has zero live call sites anywhere in this codebase today (a pre-existing gap, confirmed via grep, not something this phase expands into fixing).
- A pure item-for-item barter (no cash adjustment) never gets an escrow transaction — there is no payment to hold custody over.
- The `escrow-transaction-released` email is the only new template — funding is an internal custody event, not something a user needs notified about (matches the established "don't invent an email for every internal state" precedent).

## Regression coverage

`scripts/verify-escrow-phase3.mjs` — probes whether `ESCROW_ENABLED=true` on the running dev server and adapts: the safe-by-default proof always runs; the full lifecycle (creation, funding, release-on-completion, dispute-freeze, admin refund/cancel, webhook dedup, idempotent-replay rejection) runs only when escrow is live, otherwise each scenario is explicitly skipped and labeled, never silently passed.
