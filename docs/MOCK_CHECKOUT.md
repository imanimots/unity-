# Mock Checkout (Step 5 — Visible Test Payment Flow)

Makes the existing Financial Orchestrator (`docs/FINANCIAL_ORCHESTRATION.md`) and
`MockProvider` (`docs/PAYMENT_ARCHITECTURE.md`) reachable through the website, so the
full booking → checkout → financially-ready journey can be exercised end to end without
Peach Payments or real money. No new payment behaviour was added — `MockProvider`'s
existing scenario system already covered every deterministic outcome this step needs; the
work here is a new `src/lib/checkout/` domain plus renter-facing UI that exposes it
safely.

## Architecture

```
Booking domain (accepted booking)
        ↓
Checkout application layer (src/lib/checkout/)
  - eligibility.ts        -- the one server-authoritative "can this renter pay?" check
  - financial-readiness.ts -- the one derived "what state is this booking's money in?" helper
  - test-scenario.ts       -- the ONLY file that knows MockScenario exists
  - load-financial-state.ts -- single read path (booking + workflow + payments)
        ↓
POST /api/bookings/[id]/checkout   (initiate AND retry -- one route)
GET  /api/bookings/[id]/financial-status  (read-only, page-load/refresh safe)
        ↓
authorizeBookingFinancials() -- unchanged Financial Orchestrator (Phase 2C)
        ↓
PaymentProvider registry -- unchanged (MockProvider active, PeachPaymentsProvider future)
```

Nothing in the checkout route, checkout page, or dashboard components imports
`MockProvider` or `MockScenario` directly — `src/lib/checkout/test-scenario.ts` is the
single adapter that translates a normalized `CheckoutTestScenario` into the orchestrator's
`testRentalScenario`/`testDepositScenario` fields. This is enforced by
`src/lib/checkout/__tests__/architecture.test.ts`.

## Why checkout is renter-triggered (a change to existing behaviour)

Before this step, `POST /api/bookings/[id]/accept` called `authorizeBookingFinancials()`
automatically right after a merchant accepted a booking — silently completing the mock
rental charge and deposit authorization with zero renter involvement, using whatever the
provider's default ('success') produced. That is incompatible with this step's required
journey ("renter selects a deterministic mock outcome" *before* authorization runs), so
the automatic call was removed from the accept route. Financial authorization is now
triggered exclusively by the renter's own checkout attempt. This is a behavioural change,
not a schema or booking-lifecycle change — `accept_booking_request()` and
`booking_status` are untouched; only *when* the pre-existing, unchanged
`authorizeBookingFinancials()` function gets called moved from "automatically after
acceptance" to "explicitly at checkout."

A booking is therefore "accepted but unpaid" indefinitely until the renter checks out —
this is the state Step 6 is expected to build real booking-lifecycle rules against (e.g.
blocking `start_rental` until financially ready). Step 5 deliberately does not add that
gate to `booking-actions.tsx`; "Start rental" still renders at `accepted` for both roles,
unchanged from before this step, per this step's explicit scope boundary.

## Checkout eligibility

`checkCheckoutEligibility()` (`src/lib/checkout/eligibility.ts`) is the one server
function every mutating and read route calls. A renter may check out only when:
authenticated, the booking belongs to them, KYC is `approved`
(`src/lib/verification/eligibility.ts`'s existing `isKycApproved`), the booking is
`accepted`, and the current financial state is neither already complete
(`financially_ready`/`no_payment_required` → `allowedActions: ['view_result']`) nor
terminally failed (`payment_failed_terminal`/`deposit_failed_terminal` →
`allowedActions: []`). Every other reachable state returns `allowedActions: ['initiate']`
(no workflow yet) or `['retry']` (a resumable workflow exists). The browser only ever
displays this result; every mutating route re-derives it server-side before doing
anything; no eligibility rule is duplicated in a React component.

**Step 6 addition**: eligibility also checks `payment_expired_at` — once a booking's payment
deadline has passed (`docs/PAYMENT_READINESS.md`), readiness becomes `expired_unpaid` and
checkout is permanently blocked (`allowedActions: []`), distinct from a terminal payment
decline. Both the checkout and financial-status routes trigger a lazy-expiry sweep
(`triggerLazyExpirySweep`) before loading state, so a booking already past its deadline is
corrected before eligibility is even evaluated.

## Financial readiness

`deriveFinancialReadiness()` (`src/lib/checkout/financial-readiness.ts`) is the one
derived helper for "what state is this booking's money in," reused by both dashboards and
the checkout page. It is never a persisted column — always re-derived from
`financial_workflows.status` and the two payments' (`rental_charge`, `deposit`) own
`status` columns, so there is exactly one source of truth (`bookings` gains no new
financial field). States: `not_prepared`, `awaiting_payment`, `processing`,
`payment_failed_retryable`, `payment_failed_terminal`, `deposit_failed_retryable`,
`deposit_failed_terminal`, `financially_ready`, `no_payment_required` (reachable only if a
booking's total is ever ≤ 0 — not currently produced by any listing/booking rule, kept
for completeness). This helper is intended for reuse by Step 6.

## Deterministic mock scenarios

`src/lib/checkout/test-scenario.ts` catalogues exactly 7 scenarios and maps each to the
existing `MockScenario` values `MockProvider` already implements — no provider code
changed:

| Checkout scenario | Rental step | Deposit step |
|---|---|---|
| `success` | success | success |
| `rental_declined` | declined (terminal) | not reached |
| `deposit_declined` | success | declined (terminal) |
| `rental_retryable_failure` | retryable_failure | not reached |
| `deposit_retryable_failure` | success | retryable_failure |
| `timeout` | timeout | timeout (whichever step is still pending on resume) |
| `zero_deposit_success` | success | n/a — this is a booking precondition (`deposit_amount_snapshot = 0`), not a distinct provider behaviour; `prepareBookingFinancials` already skips creating a deposit payment when none is required |

`timeout` maps the same raw scenario to both steps deliberately: the orchestrator only
ever calls the provider for whichever step hasn't reached its target status yet, so the
same value naturally "does the right thing" on a fresh attempt (applies to rental) and on
a resumed retry (applies to deposit, since rental is already `captured` and skipped).

## Test-mode gating

Scenario selection is permitted only when **both** are true: `PAYMENT_PROVIDER=mock` and
the environment is explicitly test/development. `isMockScenarioSelectionAllowed()`
(`src/lib/checkout/test-scenario.ts`) checks `NEXT_PUBLIC_PAYMENT_MODE` first (`"test"` →
allowed, anything else → blocked); if that var is unset entirely, it falls back to
`NODE_ENV !== 'production'` so a real production build stays closed by default even if an
operator forgets to set the payment-mode var explicitly. This gate is checked twice:
server-side in `POST /api/bookings/[id]/checkout` (a forged `test_scenario` in the request
body is rejected with 400 outside mock/test mode, regardless of what the client renders)
and again by the checkout page before rendering `TestPaymentScenarioSelector` at all
(driven by `testModeAvailable` on the `GET .../financial-status` response).

## Initiation and retry

A single route, `POST /api/bookings/[id]/checkout`, handles both — `authorizeBookingFinancials()`
is itself resumable, so a fresh call prepares-then-authorizes from scratch and a retry call
resumes whichever step (rental or deposit) did not complete; an exact idempotency-key
replay against an already-completed workflow returns the cached result with no new
provider call. The browser sends only `idempotency_key` and, in mock/test mode only, a
`test_scenario` — amounts, statuses, provider references, and ids are always derived
server-side from the booking's trusted financial snapshot and current payment/workflow
state.

**Terminal decline**: the workflow's own `failed_terminal` status makes the *same*
booking's checkout permanently ineligible (`allowedActions: []`) — `payments` has no valid
transition out of `'failed'` (see `transition_payment_status`'s state table in
`supabase/migrations/20260801000004_payment_rpcs.sql`), and `financial_workflows`
(`unique(booking_id, workflow_type)`) allows only one `authorize_booking_financials`
workflow per booking, so a genuinely new attempt requires a new booking — consistent with
the precedent already documented in `docs/FINANCIAL_ORCHESTRATION.md`.

**Retryable failure or timeout**: the route returns HTTP 503 with
`status: "failed_retryable"`; the checkout page shows a retry action; a fresh POST (new
idempotency key) resumes via the orchestrator's own per-payment-status check — the step
that already succeeded is never repeated, confirmed live (Scenario C below): a retryable
deposit failure followed by a successful retry left the rental payment's single row
untouched at `captured` throughout, and never re-invoked `provider.chargeRental()`.

## HTTP status mapping

| Outcome | Status | Body |
|---|---|---|
| Success (fresh or resumed) | 200 | `{status:"success", readiness, rentalStatus, depositStatus}` |
| Terminal decline (`provider_declined`, `terminal_provider_error`) | 200 | `{status:"failed_terminal", error}` — a well-formed business outcome, not a request failure |
| Retryable (`provider_timeout`, `retryable_provider_error`, `provider_unavailable`) | 503 | `{status:"failed_retryable", readiness, error}` |
| Not eligible (KYC, ownership, wrong state, already complete, terminal) | 422 | `{error, reasons[], readiness}` |
| Unauthenticated | 401 | `{error}` |
| Wrong role | 403 | `{error}` |
| Booking not found / not owned by requester | 404 | `{error}` |
| Test scenario supplied outside mock/test mode | 400 | `{error}` |
| Malformed body | 400 | `{error, fieldErrors}` |

## A gap this step found and fixed

Live validation (Scenario B below) surfaced that the pre-existing orchestrator
(`ensureRentalCharged`/`ensureDepositAuthorised` in
`src/lib/payments/orchestrator/authorize-booking-financials.ts`) marked a decline only on
the *workflow* (`financial_workflows.status = 'failed_terminal'`) and never transitioned
the *payment* itself — `payments.status` stayed `'pending'` forever and
`payments.failure_reason` stayed `null`, even after a terminal decline. That silently
broke this step's own "failed outcomes remain visible" requirement (the renter-facing
failure reason and the merchant/renter dashboards' payment-status badge both read directly
from `payments`). Fixed by calling the already-existing `transition_payment_status` RPC
with `p_new_status: 'failed'` (a transition the RPC's state table already allowed, just
never invoked from this path) immediately before recording the workflow failure — scoped
to the terminal-decline branch only; retryable/timeout failures correctly leave
`payments.status` at `'pending'` so a later successful retry can still transition it to
`'captured'`/`'authorised'`.

A second, unrelated gap was fixed in the same pass: `authorizeBookingFinancials` and
`prepareBookingFinancials` both defaulted `ctx.providerName` to the literal string
`'mock'` in their own destructuring, bypassing the provider registry's
`PAYMENT_PROVIDER`-env fallback entirely — meaning every booking's financials were
authorized via a hardcoded mock provider regardless of environment configuration. Fixed by
resolving `ctx.providerName || process.env.PAYMENT_PROVIDER || 'mock'` in both files
(matching the registry's own resolution order) — required for this step's own
"change `PAYMENT_PROVIDER`, nothing else" provider-switching guarantee to actually hold.

## Renter and merchant status wording

Renter-facing copy (`FINANCIAL_READINESS_RENTER_COPY`) and merchant-facing copy
(`FINANCIAL_READINESS_MERCHANT_COPY`) are two separate tables in
`src/lib/checkout/financial-readiness.ts`, not one shared string set — the merchant never
sees a raw provider failure reason (`payments.failure_reason`, e.g. `"card declined"`);
only the renter's own `GET /api/bookings/[id]/financial-status` response includes it
(confirmed live: a merchant's session cannot even reach that route for a booking where
they are not the renter — see Security below). Both dashboards (`.../renter/bookings`,
`.../merchant/bookings`) derive readiness via the session-scoped Supabase client directly
(RLS already permits booking parties to read their own `payments`/`financial_workflows`
rows — `supabase/migrations/20260801000003_payment_security.sql`,
`20260802000001_financial_workflow_schema.sql`), not through the API route, avoiding a
redundant self-fetch.

## Test-mode disclosure

The checkout page shows, unconditionally: *"Test payment mode — no real money will be
charged."* No PayFast or Peach branding, no card-network logos, no "escrow secured" or
"funds held in a regulated trust account" language, and "payment completed"-style wording
only appears once the mock financial state has actually reached `financially_ready`. The
scenario selector additionally shows `Provider: MockProvider` (dev/test-only wording,
permitted by the brief).

**Deliberate scope boundary**: pre-existing "escrow" marketing copy on the public listing
detail page (`src/app/(marketing)/listings/[id]/page.tsx`) and the booking card
(`src/components/listings/booking-card.tsx`) was left untouched. That copy describes the
deposit feature conceptually to browsing visitors, outside the checkout flow itself; this
step's remove/replace mandate is scoped to checkout, not general platform marketing
copy.

## Security boundary

Verified live against the dev Supabase project (see below) and by unit test:
unauthenticated checkout → 401; a merchant attempting to check out (role check) → 403; a
merchant reading `GET .../financial-status` for a booking where they are the merchant but
not the renter → 404 (the route is renter-scoped only, ownership checked before any other
logic runs); a renter attempting to pay another renter's booking → 404 (same check);
amounts/merchant id/renter id/payment status/provider reference are never accepted from
the request body (the checkout Zod schema has exactly two fields:
`idempotency_key`, `test_scenario`); a terminal decline blocks every further attempt on
that booking (422, `allowedActions: []`); an already-`financially_ready` booking blocks
re-charging (422, `allowedActions: ['view_result']`); `test_scenario` outside mock/test
mode → 400 server-side regardless of what the client sends; no route allows a direct
`payments`/`financial_workflows` status write or a direct RPC call — every mutation goes
through `authorizeBookingFinancials()`.

## Tests

50 new tests in `src/lib/checkout/__tests__/` (`eligibility.test.ts`,
`financial-readiness.test.ts`, `test-scenario.test.ts`, `architecture.test.ts`), covering
eligibility (10), security (8, split across eligibility/test-scenario), success (6),
declines (4), retryable failure (5), timeout (3), architecture fitness (6, including two
new checks specific to Step 5's accept/checkout separation), plus a pre-existing
orchestrator architecture test (`src/lib/payments/orchestrator/__tests__/architecture.test.ts`)
updated to assert the accept route no longer imports the orchestrator at all. Full suite:
422 tests passing, zero failures.

## Live validation (dev Supabase, MockProvider)

Run against real QA accounts (`phase2a-renter-c@unitytest.co.za`,
`phase2a-merchant-a@unitytest.co.za`, both KYC-approved) and freshly created bookings via
the actual `POST /api/bookings` → `POST /api/bookings/[id]/accept` →
`POST /api/bookings/[id]/checkout` HTTP path (not a direct DB/orchestrator call) —

- **Scenario A (success, with deposit)**: fresh `accepted` booking → `GET financial-status`
  showed `readiness: "awaiting_payment"`, `allowedActions: ["initiate"]` → `POST checkout`
  with `test_scenario: "success"` → `200 {status:"success", readiness:"financially_ready",
  rentalStatus:"captured", depositStatus:"authorised"}` → re-fetched status confirmed
  `allowedActions: ["view_result"]`, further checkout attempts now blocked (422).
- **Scenario A2 (zero-deposit success)**: same flow on a listing with no deposit →
  `depositStatus: null`, `financially_ready` reached without ever creating a deposit
  payment row.
- **Scenario B (rental declined, terminal)**: `POST checkout` with `test_scenario:
  "rental_declined"` → `200 {status:"failed_terminal", error:"card declined"}` →
  `financial-status` showed `readiness:"payment_failed_terminal"`, `allowedActions: []`,
  `rentalFailureReason:"card declined"` (after the fix above) → a further `POST checkout`
  with a new idempotency key and `test_scenario: "success"` → correctly blocked at 422,
  never reaching the provider.
- **Scenario C (deposit retryable failure → retry)**: `test_scenario:
  "deposit_retryable_failure"` → `503 {status:"failed_retryable",
  readiness:"payment_failed_retryable"}`; `financial-status` showed
  `rentalPaymentStatus:"captured"` already, `depositPaymentStatus:"pending"`,
  `allowedActions:["retry"]` → retried with `test_scenario:"success"` and a new
  idempotency key → `200 {status:"success", rentalStatus:"captured",
  depositStatus:"authorised"}`; confirmed via direct query that the booking has exactly
  one `rental_charge` payment row throughout (no duplicate charge on retry).
- **Scenario D (timeout → retry)**: `test_scenario:"timeout"` → `503 failed_retryable` →
  an exact idempotency-key replay of the same failed attempt returned the same 503
  without a new provider call → a retry with a new key and `test_scenario:"success"` →
  `200 financially_ready`; confirmed exactly one payment row per type persisted for the
  booking (no duplication from the replay).
- **Scenario E (security)**: unauthenticated `POST`/`GET` → 401; merchant `POST checkout`
  on a renter's booking → 403 (role check); merchant `GET financial-status` on a booking
  where they are the merchant but not the renter → 404. KYC-gate, forged-amount, and
  mock-scenario-outside-mock-mode cases are covered by unit tests operating on the exact
  same `checkCheckoutEligibility`/`isMockScenarioSelectionAllowed` functions the live
  routes call, rather than a separate live HTTP simulation (no second QA renter with a
  non-approved KYC status, and flipping `PAYMENT_PROVIDER`/`NODE_ENV` live would have
  required restarting the dev server against a different `.env.local`).

## Mock-to-Peach replacement steps

Unchanged by any future Peach work: booking financial snapshots, the Financial
Orchestrator, `payments`/`payment_attempts`/`payment_events`/`ledger_entries`,
`checkCheckoutEligibility`, `deriveFinancialReadiness`, the checkout API routes' request
shape, `PaymentBreakdown`/`FinancialReadinessCard`/`PaymentStatusBadge`/
`PaymentAttemptSummary`, both dashboards. To switch: (1) implement
`PeachPaymentsProvider`'s remaining methods (`docs/PEACH_INTEGRATION.md` already covers
the proof-of-concept pieces); (2) add Peach-hosted checkout initiation UI (replacing, not
extending, the current checkout page's action button); (3) handle the Peach
return/callback; (4) process Peach webhooks (the webhook route and normalizer already
exist from Phase 2D); (5) set `PAYMENT_PROVIDER=peach`; (6) `TestPaymentScenarioSelector`
stops rendering automatically (`isMockScenarioSelectionAllowed()` returns `false` the
moment the provider isn't `mock`) — no code change needed to hide it.

## Known limitations

- `bookings.platform_fee_amount` is inconsistent across existing test data (some rows
  `0`, some `75` — 5% of a `1500` subtotal) from earlier phases' test runs; the checkout
  summary displays whatever value is on the booking snapshot as-is (only rendering it when
  `> 0`) and does not attempt to recompute or reconcile it — out of this step's scope.
- No polling/websocket auto-refresh on the checkout page — a retry requires the renter to
  click again; `MockProvider` responds synchronously so there is no genuine "processing"
  window to poll during in this phase.
- `checkout_sessions` was deliberately not added — `financial_workflows` + `payments`
  already persist everything needed for "a page refresh must not lose the financial
  result" (confirmed live: `GET financial-status` after an interrupted flow correctly
  reconstructs state from these two tables alone).
- The in-memory rate limiter (`src/lib/rate-limit.ts`, pre-existing, reused unchanged on
  the checkout route) is per-process only, same known limitation as every other route that
  uses it.
