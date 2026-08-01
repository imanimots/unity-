# Payment Architecture (Phase 2C)

Financial domain model and payment-provider abstraction for Unity. No real payment
provider is integrated in this phase — no real Peach API calls, no real card processing,
no real webhooks, no settlement, no bank transfers. This is the architecture a real
provider will plug into later.

The domain model described here (payment state machine, ledger, provider abstraction) is
consumed by, but does not itself contain, the Financial Orchestrator built in the
following pass — see `docs/FINANCIAL_ORCHESTRATION.md` for how booking events reach this
domain, the workflow/resumability model, and the booking↔payment consistency model.

## Existing structures discovered and reused

Audited before building anything: no functional payment code existed anywhere in the
repository. `bookings.payfast_payment_id` (and the same column on `orders`) is a legacy,
unused text column from the original baseline schema — left in place, matching the
established "supersede, don't drop" pattern from Phase 2B, since dropping it isn't
necessary and the new `payments` table supersedes its purpose. "Escrow" language on
marketing pages and the merchant payouts dashboard (`/dashboard/merchant/payouts`, still
fully mock-data-driven) are UI copy, not functional code — untouched, since this phase
is backend architecture, not a UI rewrite. The payouts page does document a real, useful
fact: **Unity charges a 5% platform fee on each completed rental** — this is the rate
`calculatePlatformFee()` and the ledger's platform-fee entries use.

## Booking ↔ payment relationship

Bookings remain authoritative for rental lifecycle; payments remain authoritative for
money movement. Neither RPC set touches the other's tables — no booking RPC
(`supabase/migrations/20260730000007_booking_rpcs.sql`) references `payments`, and no
payment RPC (`20260801000004`) updates `bookings.status`. This is satisfied by
construction, not by a runtime guard: the two domains simply never write to each other.

## Payment state machine

Deliberately separate from `booking_status` — a rental's lifecycle and its money movement
are independent state machines that happen to correlate, not the same thing.

```
pending → authorised → captured ⇄ partially_captured → refunded ⇄ partially_refunded
        ↘ captured                                    ↘ chargeback
        ↘ failed / cancelled / expired      authorised → released / cancelled / expired
```

| From | To |
|---|---|
| pending | authorised, captured, failed, cancelled, expired |
| authorised | captured, partially_captured, released, cancelled, expired |
| captured | refunded, partially_refunded, chargeback |
| partially_captured | captured, refunded, partially_refunded, chargeback |
| partially_refunded | refunded, chargeback |
| released, refunded, failed, cancelled, expired, chargeback | *(terminal — no further transitions)* |

Enforced in exactly one place: `transition_payment_status()`'s explicit `case` statement
(SQL) and mirrored in `src/lib/payments/state-machine.ts` (TypeScript, unit-tested,
non-authoritative — the RPC is what actually enforces it).

## Payment domain model

Six tables, each covering a distinct concern:

- **`payments`** — one row per payment intent, `payment_type` (`deposit` | `rental_charge`)
  distinguishing a deposit's authorise/release/capture path from a rental charge's
  pending/capture path. A separate `deposit_authorizations` table was considered and
  folded in here — the task's own suggested `payment_status` list already covers both
  paths in one enum, so two tables would have meant duplicating the same state machine.
- **`payment_attempts`** — each provider-facing attempt (a declined card retried is a new
  attempt, not a new payment).
- **`payment_events`** — append-only, immutable audit trail of every status transition
  (same `prevent_row_mutation()` trigger as `booking_history`/`listing_history` — reused,
  not duplicated; live-verified to block even `service_role`).
- **`refunds`** — its own status, since a refund can be pending/processing/failed
  independently of its parent payment's status.
- **`merchant_payouts`** — money owed to a merchant. No real bank transfer happens; this
  models the obligation.
- **`ledger_entries`** — immutable financial ledger, see below.

Plus **`payment_webhook_events`** — raw incoming provider webhooks, kept separate from
`payment_events` (our own trusted internal record) since a webhook is untrusted external
input before it's verified.

A separate `transaction_references` table was considered and not built — a
`provider_reference` text column on the tables that need one is sufficient; a dedicated
table would track nothing a foreign key doesn't already give for free.

## Ledger

Append-only, immutable (RLS enabled, zero client policies at all — not even a read policy;
parties see their own `payments`/`refunds`/`merchant_payouts` rows, which is the
user-facing view of the same facts). A mistaken entry is corrected with an offsetting
reversal entry (`reversal_of`), never edited or deleted — there is no UPDATE/DELETE
policy for any role.

`transition_payment_status()` writes ledger entries only for transitions that represent
real financial movement: a captured `rental_charge` writes both a `rental_charge` entry
and a `platform_fee` entry (5%, `round(amount * 0.05, 2)`); a deposit reaching
`authorised`/`released`/`captured`/`partially_captured` writes `deposit_hold` /
`deposit_release` / `deposit_capture` respectively. Mirrored in
`src/lib/payments/ledger.ts`'s `deriveLedgerEntries()` for unit testing.

## Provider abstraction

`src/lib/payments/provider.ts` defines the `PaymentProvider` interface
(`createPaymentIntent`, `authorizeDeposit`, `captureDeposit`, `releaseDeposit`,
`chargeRental`, `refund`, `createMerchantPayout`, `verifyWebhook`, `healthCheck`). The
booking/payment engine is written against this interface only.

`src/lib/payments/registry.ts` resolves a provider by name (`PAYMENT_PROVIDER` env var,
default `mock`). Two providers registered:

- **`MockProvider`** — fully functional, entirely simulated. Every operation succeeds
  deterministically and returns a `mock_`-prefixed reference. `verifyWebhook()` uses a
  trivial fixed-string signature scheme (`x-mock-signature: mock-signature`), used only by
  tests and the webhook framework's own plumbing tests — never a stand-in for a real
  signature algorithm.
- **`PeachPaymentsProvider`** — stub. Every money-moving method throws
  `NotImplementedError`. `healthCheck()` is the one exception — it returns
  `{healthy: false}` rather than throwing, so a future monitoring check can call it safely
  without crashing.

## Webhook framework

`POST /api/payments/webhooks/[provider]` — provider-isolated by the route segment itself
(a "peach" webhook can never be processed as "mock" or vice versa). Flow: read the raw
body (never parse before verifying — signature schemes sign raw bytes), call that
provider's own `verifyWebhook()`, then call `record_webhook_event()` whose
`(provider, provider_event_id)` unique constraint is the actual duplicate/replay defense —
live-verified: an exact replay of the same event returns `duplicate_ignored` with no
second row ever created. An invalid-signature webhook is still recorded (with
`signature_valid = false`) for audit rather than silently dropped, then rejected with 401.

Translating a verified, new event into an actual payment-status transition is deliberately
not implemented — that mapping is provider-specific and there is no real provider to map
from yet. This phase builds the intake/dedup/audit framework only.

The Financial Orchestrator pass adds one narrow step after a new event is recorded: a
placeholder `normalizeEvent()` (synthetic `{event_id, type, booking_id}` shape only, not a
real Peach mapping) feeds `reconcileProviderEvent()`, which can resume a
`failed_retryable` `financial_workflows` row for the event's booking. This is reconciliation
of an *already-known* stuck workflow, not a general event→payment-status mapping — see
`docs/FINANCIAL_ORCHESTRATION.md`'s "Webhook reconciliation" section.

## Security model

No client may set payment status, alter amounts, alter payouts, alter platform fees, or
mark a payment successful. Every payment table has a read-only policy for its parties (or,
for `ledger_entries`/`payment_webhook_events`, no client policy at all) and zero
INSERT/UPDATE policies for `anon`/`authenticated`. All six RPCs are `SECURITY DEFINER`,
`set search_path = public`, and `EXECUTE`-revoked from `anon`/`authenticated` — granted
only to `service_role`, empirically verified against the live database after every
migration, not assumed from the SQL text. A `protect_payment_privileged_fields` trigger is
additional defense-in-depth on `payments` in case a policy is ever mistakenly
reintroduced, mirroring the same pattern already used for `bookings` and `listings`.

Identity is always derived server-side (the booking's own `renter_id`/`merchant_id`, or a
trusted route's already-verified session) — never taken from client input.

## Idempotency

Same pattern as bookings and listings — `idempotency_keys` reused as-is. One live bug was
found and fixed during validation: `idempotency_keys.merchant_id` carries a hard foreign
key to `profiles(id)` (from Phase 2A). `create_payment_intent`,
`transition_payment_status`, and `create_refund` initially scoped their idempotency check
by `booking_id`/`payment_id` — neither is a `profiles.id` — so every idempotent call
failed the foreign key before reaching any business logic. Fixed
(`20260801000005_payment_idempotency_fk_fix.sql`) by reordering each function to look up
the relevant row first and scope by its `renter_id`, always a real profile id. Confirmed
live after the fix: intent creation, status transitions, and refunds all replay correctly.

`record_payment_attempt` and `record_webhook_event` use their own tables' unique
constraints for dedup instead — a retried card attempt or a replayed webhook has a more
natural dedup key than a client-generated idempotency string.

## Known limitations / future extension points

- ~~No API route wires a real booking-lifecycle event (e.g. "merchant accepted") to
  actually create a payment intent yet~~ — closed by the Financial Orchestrator pass, then
  revised by Step 5: `authorizeBookingFinancials()` is no longer called automatically from
  `POST /api/bookings/[id]/accept` — it is invoked explicitly by the renter via
  `POST /api/bookings/[id]/checkout` instead, so the renter can select a test outcome
  before authorization runs. See `docs/FINANCIAL_ORCHESTRATION.md` "Consistency model with
  the booking domain" and `docs/MOCK_CHECKOUT.md` for the current connection.
- `PeachPaymentsProvider` is a stub; every real Peach API call, webhook signature
  algorithm, and event-shape mapping remains to be built.
- Platform fee is a flat 5%, not configurable per merchant/listing/category.
- No merchant payout *processing* (bank transfer) — `merchant_payouts` only models the
  obligation.
- `payment_attempts` exists and is written to (`record_payment_attempt`), but nothing
  yet calls it from a real retry flow (there is no real provider to retry against).

## Out of scope (explicitly not built this phase)

Real Peach API integration, real card processing, real webhook signature verification
against an actual provider, settlement, bank transfers, merchant onboarding.
