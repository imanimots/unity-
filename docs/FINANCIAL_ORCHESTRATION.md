# Financial Orchestration (Phase 2C Final Architectural Fix)

A provider-agnostic orchestration layer sitting between booking-domain events and the
Phase 2C financial domain (`docs/PAYMENT_ARCHITECTURE.md`). No real Peach Payments
integration exists in this phase — `MockProvider` is the only functional provider;
`PeachPaymentsProvider` is still a stub. This document describes the orchestrator's
responsibilities, the workflow/state model it introduces, its consistency model with the
booking domain, its idempotency and recovery guarantees, and the webhook reconciliation
design.

## Why an orchestrator, not more booking-domain code

Before this pass, nothing connected a booking lifecycle event to the financial domain —
`docs/PAYMENT_ARCHITECTURE.md`'s "known limitations" section named this gap explicitly.
The orchestrator exists to close it without collapsing two domains that must stay
independent: booking state (requested/accepted/active/...) and payment state
(pending/authorised/captured/...) are enforced by their own RPCs and must remain
enforceable that way even after they start calling each other. Concretely:

- No booking file imports a concrete provider (`MockProvider`, `PeachPaymentsProvider`)
  directly — only the orchestrator barrel (`src/lib/payments/orchestrator`).
- No provider file references `bookings` or `booking_status` — a provider adapter only
  ever sees payment-shaped inputs (`paymentId`, `amount`, `currency`, ...).
- The orchestrator resolves providers through the existing registry
  (`getPaymentProvider(providerName)`), never `new MockProvider()` / `new
  PeachPaymentsProvider()` directly.
- The orchestrator never inserts into `ledger_entries` (or any other financial table)
  itself — every ledger-affecting step goes through an existing or new
  `SECURITY DEFINER` RPC, same as every other financial write in this codebase.

These four rules are enforced by an automated "architecture fitness function"
(`src/lib/payments/orchestrator/__tests__/architecture.test.ts`), which scans file
contents rather than merely asserting behavior — a regression here fails a unit test, not
just a design review.

## Workflows

| Workflow | Function | Provider calls | Resumable via |
|---|---|---|---|
| Prepare booking financials | `prepareBookingFinancials(ctx, bookingId, idempotencyKey?)` | none — only creates `payments` rows | `payments_booking_type_unique` + get-or-create |
| Authorize booking financials | `authorizeBookingFinancials(ctx, bookingId, idempotencyKey?)` | up to 2 (rental charge, deposit auth) | `financial_workflows` row + per-payment status check |
| Release deposit | `releaseDeposit(ctx, bookingId, idempotencyKey?)` | 1 (release) | payment status (`released` short-circuits) + `idempotency_keys` |
| Capture deposit | `captureDeposit(ctx, bookingId, amount, reason, idempotencyKey?)` | 1 (capture) | `capture_deposit_amount` RPC's own idempotency handling |
| Create merchant payout | `createMerchantPayout(ctx, bookingId, idempotencyKey?)` | 0 (Step 11 Phase 8 — creates the pending obligation only, never calls a provider; see below) | `create_merchant_payout` RPC's own idempotency handling |

**Prepare** derives both amounts entirely from the booking's own immutable financial
snapshot (`subtotal_amount`, `deposit_amount_snapshot`) — there is no amount parameter on
the function signature, so a caller cannot supply one even by mistake. A deposit payment
is only created if `deposit_amount_snapshot > 0`.

**Authorize** is the one workflow that is genuinely multi-step (see "Resumability" below)
and the only one backed by a `financial_workflows` row.

**Capture deposit** is a domain workflow only — it is not exposed to any user-facing route
this pass. There is no existing admin action boundary to safely gate it behind yet (a
future dispute/admin phase is the intended caller); the function itself still enforces
`amount > 0` and a non-empty `reason` as if it might be called from anywhere, since
"trusted server-side caller" is a deployment fact, not something the function can verify
about its own caller.

**Merchant payout creation (Step 11 Phase 8 addendum).** `createMerchantPayout()` had zero call
sites anywhere in the app until this phase — now hooked into `POST /api/bookings/[id]/confirm-return`
as a best-effort call after the booking reaches `completed`. As of this phase it also **never
calls a payout provider** (a binding review correction) — it creates the `pending` payout
obligation only; provider invocation belongs to a later, separately-approved processing
integration. A missing payout caused by a transient failure at this hook is repaired by
`POST /api/internal/payouts/reconcile-missing`, not by retrying the confirm-return call. See
`docs/MERCHANT_PAYOUT_WORKFLOW.md`.

**Affiliate commission qualification (Step 11 Phase 7 addendum).** `authorizeBookingFinancials()`
and order checkout's `chargeOrderPayment()` each call a best-effort, try/catch-wrapped affiliate
qualification RPC immediately after a `rental_charge`/`order_payment` capture succeeds — never a
new workflow, never able to affect the payment's own status or block/roll back the underlying
charge on failure. See `docs/AFFILIATE_SYSTEM.md`.

## Why only one workflow needed a `financial_workflows` row

`financial_workflows` (new table, `supabase/migrations/20260802000001_financial_workflow_schema.sql`)
exists specifically because `authorizeBookingFinancials` makes two independent provider
calls per invocation and must resume at whichever one didn't complete, without repeating
the one that did. Every other workflow here is a single provider call feeding a single
payment-status transition — the existing `idempotency_keys` pattern (or, for capture and
payout, the underlying RPC's own idempotency handling) is already sufficient for exact
replay and duplicate detection. Adding a workflow row to those would track state that
`payments.status` and `idempotency_keys` already track, for no additional guarantee — so
none was added. This was a deliberate scope decision, not an oversight.

## Workflow status model

```
pending → processing → completed
                     ↘ failed_retryable → processing (resume)
                     ↘ failed_terminal   (no further transitions)
```

`workflow_status` is a new enum, deliberately disjoint from `payment_status` and
`booking_status` — it describes the orchestration process's own progress, not a booking's
or a payment's state. A `failed_terminal` row cannot be resumed automatically:
`start_or_resume_financial_workflow()` raises an exception naming the terminal state
rather than silently restarting it, and the orchestrator surfaces that as
`duplicate_workflow_conflict` — a fresh, deliberate decision is required to try again
(e.g. a new booking, or an explicit admin action once one exists), never an automatic
retry of a declined charge.

## Resumability

Two mechanisms work together:

1. **`financial_workflows`** — one row per `(booking_id, workflow_type)`, tracking
   `status` / `current_step` / `retry_count` / `last_error_code` across invocations. This
   is what a future dashboard or admin tool would read to answer "what's stuck and why."
2. **Per-payment status checks** — before calling the provider for a given step,
   `ensureRentalCharged()` / `ensureDepositAuthorised()` check whether that payment has
   already reached its target status (`captured` / `authorised`) and skip the provider
   call entirely if so. This is the primary correctness net: even without the workflow
   row, re-deriving "what's left to do" from `payments` alone is safe. The workflow row
   adds the single overall status and observability the task calls for; it does not by
   itself prevent a duplicate provider call — the payment-status check does.

A call whose idempotency key matches an already-`completed` workflow returns the cached
`result` from that row immediately — no provider call, no RPC beyond the initial lookup.

### Partial failure — worked example (Scenario B, live-verified)

1. Booking accepted, `authorizeBookingFinancials` called with idempotency key `K`.
2. Rental charge succeeds (`captured`); deposit authorization is configured (via
   `ctx.testDepositScenario`, mock-only) to fail with `retryable_failure`.
3. The orchestrator records the rental's `payment_attempts` row, transitions it to
   `captured`, then attempts the deposit, catches `RetryableProviderError`, calls
   `failWorkflow(..., 'failed_retryable', 'retryable_provider_error', ...)`, and throws
   `OrchestrationError('retryable_provider_error', ...)`.
4. Live-verified state after step 3: exactly one `payment_attempts` row for the rental
   payment, exactly one `ledger_entries` row of type `rental_charge` and one
   `platform_fee` — no deposit-side ledger entries at all, no duplicates.
5. Deposit scenario reconfigured to `success`; `authorizeBookingFinancials` called again
   with the **same key `K`**.
6. `start_or_resume_financial_workflow` finds the existing `failed_retryable` row,
   transitions it to `processing`, increments `retry_count`.
7. `ensureRentalCharged` re-selects the rental payment, sees `status === 'captured'`,
   returns immediately — **no second provider call, no second `payment_attempts` row, no
   second ledger entry.** Only `ensureDepositAuthorised` actually calls the provider.
8. Live-verified after the resume: rental side unchanged (still exactly 1 attempt, 1
   ledger pair); deposit side now has its own single attempt and a single `deposit_hold`
   ledger entry; workflow row is `completed`.
9. Calling `authorizeBookingFinancials` a third time with key `K` returns the cached
   `completed` result — no new attempts, no new ledger rows, confirmed by re-querying
   `payment_attempts`/`ledger_entries` counts before and after.

### Terminal decline — the deliberate non-resumable case

A `declined` outcome (real card decline, real deposit-auth decline) is modeled as
terminal, not retryable — retrying a declined charge automatically is not something this
system does, since nothing about a decline is expected to change on its own between one
call and the next. `failWorkflow(..., 'failed_terminal', 'provider_declined', ...)` is
called, and any further call with the same idempotency key against that workflow raises
"has failed terminally and cannot be resumed" from
`start_or_resume_financial_workflow()`, surfaced as `duplicate_workflow_conflict`. A
genuinely new attempt requires a new workflow (in practice: a new booking, or — once a
retry-on-new-terms admin action exists — an explicit new key against explicitly new
input), never an automatic retry of the same terminal workflow.

## Consistency model with the booking domain

Booking acceptance and financial authorization are **not** one atomic transaction, and — as
of Step 5 (`docs/MOCK_CHECKOUT.md`) — not even triggered by the same request. Originally
(Phase 2C), `POST /api/bookings/[id]/accept` called `authorizeBookingFinancials()`
automatically, right after `accept_booking_request()`, via a `tryAuthorizeFinancials()`
wrapper that never threw across the boundary. Step 5 removed that automatic call: it
silently completed the mock rental charge and deposit authorization before the renter had
any involvement, which is incompatible with a renter-driven checkout journey where the
renter selects an outcome *before* authorization runs. Acceptance now only commits the
booking-domain transition; `authorizeBookingFinancials()` is invoked exclusively by
`POST /api/bookings/[id]/checkout`, driven by the renter. See
`docs/MOCK_CHECKOUT.md` "Why checkout is renter-triggered" for the full reasoning.

The underlying principle is unchanged: rolling back a booking acceptance because a payment
provider timed out would mean a merchant's "yes" to a renter could be silently undone by a
network blip on the *other* side of the transaction, which is a worse failure mode than
"accepted, financials pending." A booking now sits in "accepted, awaiting checkout"
indefinitely until the renter acts — Step 6 is expected to build real booking-lifecycle
rules against that state (e.g. gating `start_rental` on financial readiness), which this
phase deliberately does not add.

The same "never throw across the boundary" shape is still used by the webhook route's
reconciliation call (see below), and by the checkout route's own error handling
(`docs/MOCK_CHECKOUT.md` "HTTP status mapping").

## Database changes

- **`financial_workflows`** (new table) — `id`, `booking_id`, `workflow_type`, `status`
  (`workflow_status` enum), `provider`, `current_step`, `last_error_code`,
  `last_error_message`, `retry_count`, `idempotency_key`, `result jsonb`, timestamps.
  `unique(booking_id, workflow_type)`. RLS: one read-only policy for the booking's own
  renter/merchant; no write policy for `anon`/`authenticated` at all — only the two RPCs
  below (both `service_role`-only) ever write to it.
- **`start_or_resume_financial_workflow(p_booking_id, p_workflow_type, p_provider,
  p_idempotency_key)`** — find-or-create by `(booking_id, workflow_type)`; returns the
  cached row as-is if `completed`; raises if `failed_terminal`; transitions
  `failed_retryable → processing` (incrementing `retry_count`) otherwise.
- **`update_financial_workflow_progress(p_workflow_id, p_status, p_current_step,
  p_last_error_code, p_last_error_message, p_result)`** — persists progress, stamps
  `completed_at` when `status = 'completed'`.
- **`capture_deposit_amount(p_payment_id, p_amount, p_provider_reference, p_reason,
  p_idempotency_key)`** — new, narrowly-scoped RPC. Genuine gap found during design (not a
  live failure): the existing `transition_payment_status()` always ledger-records a
  deposit capture using the payment's **full** `amount`, which was correct for the only
  case that existed before (a full capture) but wrong for a real partial capture. This RPC
  computes `already_captured` by summing `ledger_entries` of type `deposit_capture` for
  the payment (the ledger is the source of truth — no separate running-counter column),
  rejects `p_amount > remaining`, and sets the payment to `captured` (if the capture
  exhausts the remaining balance) or `partially_captured` (otherwise), writing a ledger
  entry for the **actual captured amount**, not the payment's full amount.
  `transition_payment_status()` itself was left untouched.

All three RPCs are `SECURITY DEFINER`, `set search_path = public`, `EXECUTE` revoked from
`public`/`anon`/`authenticated`, granted only to `service_role` — verified empirically
against the live database (`can_execute` checked per role), not assumed from the SQL text.
Idempotency scoping follows the pattern already established in Phase 2C: never scope by
`booking_id`/`payment_id` directly (neither is a `profiles.id`, and `idempotency_keys`
carries a hard FK to `profiles`) — always resolve the relevant row first and scope by its
`renter_id`.

## Provider contract

No change to `PaymentProvider`'s method set — `createPaymentIntent` / `authorizeDeposit` /
`captureDeposit` / `releaseDeposit` / `chargeRental` / `refund` / `createMerchantPayout` /
`verifyWebhook` / `healthCheck` already covered every orchestrator need. The interface
remains generic; no Unity-specific method (e.g. `acceptBookingAndCharge`) was added or
would be — that composition lives in the orchestrator, not the provider. Verified by the
architecture fitness test.

Two additive-only extensions:

- **`MockScenario`** — `'success' | 'declined' | 'timeout' | 'retryable_failure' |
  'terminal_failure' | 'duplicate'`, an optional `mockScenario` field on each provider
  input type. Consulted only by `MockProvider`; a real provider ignores it entirely (there
  is nothing to plumb through to Peach). Deterministic by construction — the mock never
  makes a random choice; a test selects the exact outcome it wants.
- **Provider error classes** (`src/lib/payments/provider-errors.ts`) —
  `ProviderTimeoutError`, `RetryableProviderError`, `TerminalProviderError`. A real
  provider throwing these (once one exists) gets the same normalization the mock does; the
  orchestrator's `handleProviderError()` never needs to know which concrete provider threw.

`OrchestratorContext.testRentalScenario` / `testDepositScenario` are the mechanism for
deliberately forcing a specific step of `authorizeBookingFinancials` into a specific
failure mode. As of Step 5 these are set by a real, gated caller —
`POST /api/bookings/[id]/checkout`, only when `PAYMENT_PROVIDER=mock` and the environment
is explicitly test/development (`docs/MOCK_CHECKOUT.md` "Test-mode gating") — via
`src/lib/checkout/test-scenario.ts`'s normalized `CheckoutTestScenario` → `MockScenario`
mapping, never a raw provider value from the browser.

## Error model

Every orchestrator function throws `OrchestrationError` (never a raw Postgres error, never
a raw provider error) with one of:

`invalid_booking_state`, `missing_payment`, `duplicate_workflow_conflict`,
`provider_declined`, `provider_unavailable`, `provider_timeout`,
`retryable_provider_error`, `terminal_provider_error`, `invalid_payment_transition`,
`insufficient_deposit_authorization`, `payout_unavailable`, `internal_consistency_error`.

`isRetryableOrchestrationError(code)` is `true` only for `provider_unavailable` /
`provider_timeout` / `retryable_provider_error` — the set of codes for which calling again
with the same idempotency key might succeed. `provider_declined` is deliberately excluded.

## Webhook reconciliation

`POST /api/payments/webhooks/[provider]` keeps its existing shape (identify provider by
route segment → verify signature → dedupe via `record_webhook_event()`'s unique
constraint → record raw event). This phase adds one narrow step after a **new** (not
duplicate) valid event is recorded: a placeholder `normalizeEvent()` (understands only a
synthetic `{event_id, type, booking_id}` shape — documented explicitly as a stand-in until
a real Peach event-shape mapping exists) produces a `NormalizedPaymentEvent`, passed to
`reconcileProviderEvent(ctx, event)`.

`reconcileProviderEvent` is intentionally minimal — no business orchestration lives in the
webhook route itself:

1. No `bookingId` on the event → not reconciled.
2. No `financial_workflows` row for `(bookingId, 'authorize_booking_financials')` → not
   reconciled.
3. Row is `completed` → not reconciled ("already completed — not re-executed"); never
   re-executes a finished workflow.
4. Row is anything other than `failed_retryable` (e.g. `failed_terminal`, `pending`,
   `processing`) → not reconciled ("not resumable via reconciliation").
5. Row is `failed_retryable` → calls `authorizeBookingFinancials(ctx, bookingId)`. Any
   failure here is swallowed (not re-thrown) — the webhook route must always return 200 to
   the provider for replay safety regardless of whether reconciliation itself succeeded;
   the outcome is still durably recorded on `financial_workflows` by the orchestrator call
   itself.

Live-verified (Scenario C): a booking driven into `failed_retryable` via
`testRentalScenario: 'timeout'`, then a synthetic webhook event posted for that booking's
id, resulted in `{reconciled: true, reason: 'resumed and completed'}` and the workflow row
transitioning to `completed` — with the same no-duplicate-attempt guarantee as the direct
resume path, since reconciliation calls the exact same `authorizeBookingFinancials`
function.

## Security boundary

The orchestrator is callable only from trusted server-side code — every function takes an
`OrchestratorContext.admin`, the same service-role `SupabaseClient` every existing API
route already constructs from `SUPABASE_SERVICE_ROLE_KEY`, never a session-scoped client.
There is no generic `POST /api/payments/orchestrate`-style endpoint; the current callers
are the checkout route (`POST /api/bookings/[id]/checkout`, `authorizeBookingFinancials`
only — see `docs/MOCK_CHECKOUT.md`) and the webhook route (`reconcileProviderEvent`, itself
calling `authorizeBookingFinancials`); the booking accept route no longer calls the
orchestrator at all as of Step 5. Live-verified
(Scenario D): direct RPC calls to `start_or_resume_financial_workflow`,
`update_financial_workflow_progress`, and `capture_deposit_amount` using an authenticated
non-admin user's JWT all returned Postgres `42501 permission denied` — confirmed only after
re-authenticating with a fresh token (an earlier attempt returned `PGRST303 "JWT expired"`
from a stale cached token, not a security result, and was re-run).

## Known limitations

- `PeachPaymentsProvider` remains a stub — no real API calls, no real credentials, no
  webhook signature mapping. This phase does not change that.
- `normalizeEvent()` in the webhook route understands only a synthetic test event shape;
  real Peach webhook payloads will need a real mapping function when that integration
  begins.
- No scheduled/automatic retry of `failed_retryable` workflows exists — resumption
  currently only happens via an explicit new call (as of Step 5: the renter's own retry
  via `POST /api/bookings/[id]/checkout`, see `docs/MOCK_CHECKOUT.md`) or an inbound
  webhook event. A production scheduler that periodically re-attempts stale
  `failed_retryable` rows is out of scope this phase.
- `captureDeposit` has no route or admin UI calling it yet — it is reachable only by
  direct function call from trusted server code, pending a real admin/dispute boundary.
- Platform fee remains a flat 5%, unrelated to this phase's scope, unchanged.

## Performance

Measured against the live dev database (`mock` provider, single sequential calls, no
concurrency) via `npx tsx` process invocations. Each figure is a full process wall-clock
time, which includes a measured **~2.0s Node/tsx cold-start baseline** (verified separately
with a no-op script) on top of the actual round trips — the delta between a figure below
and ~2.0s is a closer estimate of real orchestrator + network + Postgres time than the raw
total.

| Operation | Process wall-clock | Round trips involved |
|---|---|---|
| `prepareBookingFinancials` (fresh booking, in-process timer) | 1.64s (function-internal, excludes process startup) | 2× select-then-maybe-insert (rental, deposit) |
| `authorizeBookingFinancials` (fresh, full success — includes prepare) | 4.61s | start/resume RPC, prepare (above), rental: select+update-progress+provider+attempt+transition, deposit: same 5 steps, final progress update |
| `authorizeBookingFinancials` (resume — rental already captured, only deposit retried) | 3.17s | start/resume RPC, prepare selects (2), rental: 1 select (skip, already captured), deposit: full 5-step sequence, final progress update |
| `releaseDeposit` (isolated) | 3.47s | booking select, deposit select, idempotency check, provider call, transition RPC, idempotency insert |
| `createMerchantPayout` (isolated, rental already captured) | 2.71s (Phase 2C measurement, predates Phase 8's removal of the provider call below — expect fewer round trips now) | booking select, existing-payout select, rental-payment select, ledger select, payout RPC (no provider call as of Step 11 Phase 8 — see below) |
| `accept_booking_request` + `authorizeBookingFinancials` combined (historical — Phase 2C measurement; as of Step 5 these are two separate requests, see `docs/MOCK_CHECKOUT.md`) | 4.47s | booking accept RPC + full authorize sequence above |

No premature optimization was applied. One real, identifiable pattern worth naming for a
future pass: `authorizeBookingFinancials` calls the rental and deposit provider operations
**sequentially**, even though they are independent operations against independent
payments — a future optimization could run them concurrently when both are actually
needed, cutting one provider round trip off the combined-success path. This is not applied
here, since it would change the resumability reasoning (two concurrent failures instead of
one at a time) and needs its own correctness review, not a performance-driven shortcut.
`prepareBookingFinancials`'s two `getOrCreatePayment` calls (rental, deposit) are similarly
sequential and could run concurrently without changing correctness, since they touch
different rows under the same unique constraint — the more clearly "free" win of the two,
left unapplied this pass per the "no premature optimization" instruction.

## Files

```
supabase/migrations/20260802000001_financial_workflow_schema.sql
supabase/migrations/20260802000002_financial_workflow_rpcs.sql
supabase/migrations/20260802000003_capture_deposit_amount_rpc.sql

src/lib/payments/provider-errors.ts                          (new)
src/lib/payments/provider.ts                                 (MockScenario + mockScenario field)
src/lib/payments/providers/mock-provider.ts                  (scenario handling)

src/lib/payments/orchestrator/
  types.ts
  errors.ts
  idempotency.ts
  prepare-booking-financials.ts
  authorize-booking-financials.ts
  release-deposit.ts
  capture-deposit.ts
  create-merchant-payout.ts
  reconcile-provider-event.ts
  index.ts
  __tests__/architecture.test.ts
  __tests__/errors.test.ts
  __tests__/idempotency.test.ts

src/lib/payments/__tests__/mock-provider-scenarios.test.ts

src/app/api/bookings/[id]/accept/route.ts                    (orchestrator call added)
src/app/api/payments/webhooks/[provider]/route.ts             (reconciliation call added)
```
