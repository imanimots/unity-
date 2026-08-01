# Payment Readiness, Deadlines and Handover Gating (Step 6)

Connects booking progression to financial readiness without coupling the booking domain to
a specific payment provider. Builds directly on the Step 5 checkout architecture
(`docs/MOCK_CHECKOUT.md`) and the Financial Orchestrator (`docs/FINANCIAL_ORCHESTRATION.md`)
— no provider code changed, no new booking-status enum value.

## Booking state vs. payment state

Unchanged core principle from Step 5, extended: the booking lifecycle
(`docs/BOOKING_LIFECYCLE.md`) stays authoritative for the rental agreement; financial
readiness only determines whether specific *transitions* are allowed. An accepted-but-unpaid
booking stays `accepted` — there is no `awaiting_payment` booking-status value. "Awaiting
payment" is a presentation state, derived in TypeScript from `deriveFinancialReadiness()`
(`src/lib/checkout/financial-readiness.ts`), the same helper Step 5 introduced.

Every gate in this step asks "is this booking financially ready?" — via
`deriveFinancialReadiness()` or its wrapper `getBookingFinancialEligibility()`
(`src/lib/checkout/readiness-gate.ts`) — never "did MockProvider succeed?" or "did Peach
capture the card?". Both functions read only normalized, provider-neutral values
(`payments.status`, `financial_workflows.status`) — nothing provider-specific ever appears
in a booking-domain decision.

## Deadline model

`bookings.payment_due_at` (new column) is set once, at acceptance:

```
payment_due_at = least(accepted_at + BOOKING_PAYMENT_DEADLINE_HOURS, start_at)
```

`BOOKING_PAYMENT_DEADLINE_HOURS` (default `24`) is read from exactly one place —
`src/lib/bookings/payment-deadline.ts` — and passed explicitly into
`accept_booking_request()`'s `p_payment_deadline_hours` parameter; the RPC itself has no
fallback default (a missing or non-positive value raises an exception rather than silently
defaulting), so there is exactly one authoritative source for the duration. No safety buffer
is subtracted before `start_at` — none is documented anywhere in this codebase, and none was
invented for this step (a booking accepted very close to its own start time will therefore
have a very short, or in a rare edge case already-past, payment window — see "Known
limitations").

The deadline is always server-derived — the browser never supplies it, and a
`protect_booking_privileged_fields` trigger (extended this step) reverts both
`payment_due_at` and `payment_expired_at` for any non-service-role write, on top of `bookings`
having no client-facing `UPDATE` policy at all (Phase 2B).

**Idempotency**: an exact idempotency-key replay of `accept_booking_request` returns the
originally cached result verbatim (including the original `payment_due_at`) — the deadline
is computed once, inside the RPC, only on first acceptance. A booking can never be accepted a
second time (the RPC's own `status = 'requested'` guard), so a *new* idempotency key against
an already-accepted booking simply fails with "not in requested status" rather than
recomputing or extending the deadline. Live-verified: an exact replay returned the identical
timestamp; a second acceptance attempt with a different key returned `409`.

## Financial readiness

`FinancialReadinessState` (`src/lib/checkout/financial-readiness.ts`) gained one new value
this step: `expired_unpaid` — set whenever `payment_expired_at` is non-null, checked first,
before any other derivation (an expired booking is never re-classified as `processing` or
any payment-family state, no matter what `payments`/`financial_workflows` say). The
`paymentExpired` input flag is what distinguishes this from lifecycle `expired` in general —
`expired` is also produced by the unrelated, pre-existing stale-*request* expiry
(`expires_at` / `expire_stale_booking_requests()`, Phase 2B); only a booking whose expiry was
payment-driven sets `payment_expired_at`, and only that sets `paymentExpired`.

A booking is financially ready (able to start) when readiness is `financially_ready` or
`no_payment_required` — every other state (`awaiting_payment`, `processing`, either failure
family, `expired_unpaid`) blocks a start.

## The financial-readiness gate

`getBookingFinancialEligibility(admin, bookingId)` (`src/lib/checkout/readiness-gate.ts`) is
the one trusted server helper the brief asked for. It wraps the existing
`loadBookingFinancialState` + `deriveFinancialReadiness` — it does not re-query
`payments`/`financial_workflows` itself, so every caller shares one derivation. Used by:

- `POST /api/bookings/[id]/start` — returns `422 financial_requirements_incomplete` with a
  user-safe reason and the normalized readiness state if the gate isn't satisfied.
- The renter and merchant dashboards' allowed-action calculation
  (`BookingActions`'s new `financiallyReady` prop) — an unpaid `accepted` booking never shows
  a "Start rental" button that the server would just reject.

Enforcement lives in the route, not inside `start_rental()` itself (the RPC is unchanged) —
the same choice Step 4 made for the renter-KYC-at-start check, in the same file, for the same
reason: `start_rental` is already `service_role`-only, so the Next.js route is the sole real
caller and the sole place that needs to ask.

## Booking acceptance changes

`accept_booking_request()` (extended, not replaced — the parameter was appended with a
`default null` so `CREATE OR REPLACE FUNCTION` stayed signature-compatible) now: validates
`p_payment_deadline_hours` is a positive integer; computes and stores `payment_due_at`;
records `payment_due_at` and `payment_deadline_hours` in the `booking_accepted` history row's
metadata; includes `payment_due_at` in its returned result (and therefore in any idempotent
replay). Everything else — availability locking, the exclusion constraint, auto-rejecting
conflicting requests — is unchanged.

## Unpaid-expiry workflow

`expire_unpaid_accepted_bookings()` (new RPC, service-role only) mirrors the exact
`for update skip locked` concurrency shape of the pre-existing
`expire_stale_booking_requests()` (Phase 2B) — two concurrent sweeps can never both
transition the same booking. For every `accepted` booking whose `payment_due_at` has passed,
it checks a narrow, read-only pair of facts — is the rental payment `captured`, and (if a
deposit is required) is the deposit `authorised` — and **skips** (does not expire) any
booking that is actually ready, even though its deadline passed. This check reads only
`payments.status` (a normalized, provider-neutral enum) — it is not a competing financial
model, just the one place that needs the check and the transition to be atomic in a single
statement for concurrency safety (see "Booking state vs. payment state" above for why this
couldn't just call the TypeScript helper).

For every booking it does expire: `status → expired`, `payment_expired_at → now()`, exactly
one `booking_history` row (`booking_payment_expired`). No payment, attempt, workflow, or
ledger record is ever touched. Dates free up automatically — the existing exclusion
constraint (`bookings_no_overlap_when_blocking`, Phase 2B) only blocks
`status in ('accepted', 'active')`, so an `expired` booking is invisible to it, and
`create_booking_request`'s own overlap check only excludes `accepted`/`active` too.

Live-verified end to end: an unpaid booking's deadline moved into the past (via a
service-role test update — the only way to write `payment_due_at` at all); the sweep expired
it with one history row; a repeated sweep was a no-op; checkout and start were both blocked
afterward; a new overlapping booking request succeeded and was itself accepted (dates
genuinely free, not just accepted-for-request).

## Lazy expiry

`triggerLazyExpirySweep(admin)` (`src/lib/bookings/lazy-expiry.ts`) is the one centralized
trigger, called from every trusted entry point that could otherwise act on or display a stale
`accepted` booking: `POST/GET` checkout, `GET financial-status`, `POST start`,
`GET /api/bookings/[id]`, `GET /api/bookings`, and the checkout page itself. It is
deliberately a full sweep, not a single-booking check — reusing the exact same trusted
operation a future scheduler will call keeps the "lazy path" and "scheduled path" from ever
drifting into two different expiry behaviours. Errors are swallowed, never thrown — a failed
sweep must not turn an otherwise-successful read into a 500.

Live-verified: a booking's deadline was moved into the past with no sweep run manually
afterward; the very next `GET financial-status` call transitioned it to `expired` on its own
before returning a response, proving the lazy trigger — not a stale cached state — corrected
it.

**Known scaling limitation**: at MVP scale a full table scan on every trusted read is cheap;
a high-volume production deployment should rely primarily on the scheduler (below) and treat
the lazy trigger as a safety net, not the primary mechanism.

## Late provider events

Defines the race where a booking's payment deadline expires *while* a financial
authorization is already in flight (past the eligibility gate, mid-orchestrator-call). The
booking must never be silently reactivated, and the outcome must never be silently
discarded. The smallest possible extension: `checkAndRecordLateSuccessIfExpired(admin,
bookingId)` (`src/lib/bookings/late-payment-reconciliation.ts`), called immediately after a
successful `authorizeBookingFinancials()` in both the checkout route and the webhook
reconciliation path (`reconcileProviderEvent`). If the booking is now `expired` with
`payment_expired_at` set, it calls the idempotent `record_late_payment_reconciliation` RPC,
which inserts exactly one `booking_history` row (`late_payment_reconciliation`,
`requires_manual_review: true`) — never a status change, never a payments/ledger write (the
payment itself is already correctly `captured`/`authorised` via the unchanged orchestrator;
this only flags that a human should look at it). The checkout route surfaces this as a
distinct `status: "late_success_after_expiry"` response rather than the normal success
shape, with a user-safe message pointing the renter to support. No refund is issued — out of
scope for this step.

Live-verified (via direct RPC calls against an already-expired booking, simulating the race
outcome without needing to win an actual timing race): the marker records once; a repeated
call (simulating a webhook redelivery) reports `recorded: false` and does not duplicate;
the booking's status never changes.

## Checkout and dashboard changes

The checkout page shows the payment deadline and a purely cosmetic client-side countdown
(`DeadlineCountdown` in `checkout-flow.tsx`) — server time remains authoritative regardless
of what the countdown displays; every submit and every page refresh re-derives eligibility
server-side via the lazy-expiry trigger + `checkCheckoutEligibility`, so a manipulated client
clock cannot bypass expiry. Once `readiness` is `expired_unpaid`, `FinancialReadinessCard`
shows a dedicated "Payment expired" state and no action button renders
(`allowedActions: []`); the eligibility `reasons[]` array explicitly states the booking can
no longer be paid through checkout.

Both dashboards (`.../renter/bookings`, `.../merchant/bookings`) show a "pay by" note for any
`accepted`-but-not-yet-ready booking and derive `BookingActions`'s new `financiallyReady`
prop from the same readiness value already computed there — `expired_unpaid` bookings show
the dedicated expired copy from `FINANCIAL_READINESS_RENTER_COPY` /
`FINANCIAL_READINESS_MERCHANT_COPY` and no start button. The merchant surface never receives
a raw provider failure reason — unchanged from Step 5.

## Availability behaviour

Verified live (see "Unpaid-expiry workflow" above): the DB-level exclusion constraint and the
application-level overlap check in `create_booking_request()` both already scope to
`status in ('accepted', 'active')` — an `expired` booking was never a special case requiring
new code, only confirmation that the existing scoping was correct for this new use of
`expired`.

## Cancellation interaction

No change to `cancel_booking()`. A cancelled booking (`cancelled_by_renter` /
`cancelled_by_merchant`) is structurally invisible to the unpaid-expiry sweep, which only
ever selects `status = 'accepted'` — a cancelled booking can never be later expired, and its
payment records are untouched (audit-preserved, no refund logic added). Financial readiness
plays no role in cancellation eligibility, matching existing Phase 2B rules unchanged.

## RPCs, routes and permissions

New/changed, all `SECURITY DEFINER`, `service_role`-only (verified live: `42501 permission
denied` for an authenticated non-service JWT on `expire_unpaid_accepted_bookings`):

- `accept_booking_request(..., p_payment_deadline_hours)` — extended.
- `expire_unpaid_accepted_bookings()` — new.
- `record_late_payment_reconciliation(p_booking_id, p_note)` — new.

New routes:

- `POST /api/internal/expire-unpaid-bookings` — secret-authenticated (`INTERNAL_CRON_SECRET`
  bearer token), not session-authenticated; refuses to run if the secret is unconfigured
  (closed by default, live-verified `503` with it unset, `401` with the wrong value, success
  with the correct one).

Changed routes: `POST /api/bookings/[id]/accept` (deadline param), `POST .../start` (lazy
expiry + readiness gate), `POST/GET .../checkout`, `GET .../financial-status`,
`GET /api/bookings/[id]`, `GET /api/bookings` (lazy expiry trigger added to all).

## Idempotency

Deadline assignment: covered above (replay-safe, extension-proof). Unpaid expiry: `for
update skip locked` makes concurrent sweeps produce exactly one transition per booking
(matches the Phase 2B pattern); a repeated sweep after all overdue bookings are already
handled is a pure no-op (live-verified: `{expired_count: 0}` on a second immediate call).
Late-payment reconciliation: idempotent via an existence check before insert (live-verified:
second call returns `recorded: false`).

## Security

Live-verified as an authenticated (non-service) renter, via their own session JWT: a direct
`PATCH` attempting to set `payment_due_at` affected zero rows (`bookings` has no
client-facing `UPDATE` policy at all — RLS blocks it before the privileged-field trigger even
runs); a direct `PATCH` attempting `expired → accepted` reactivation likewise affected zero
rows; a direct call to `expire_unpaid_accepted_bookings()` returned `42501`. Cross-role
checkout (merchant attempting a renter's checkout) and cross-user checkout (wrong renter)
were already blocked by Step 5's eligibility/ownership checks, unchanged and re-verified.
Client-clock manipulation cannot bypass expiry because every deadline comparison happens
against Postgres `now()` server-side — the client-side countdown is display-only and is never
consulted by any route.

## Tests

33 new tests (455 total project-wide, all passing): `financial-readiness.test.ts` (+5,
`expired_unpaid` derivation), `eligibility.test.ts` (+3, expiry blocks checkout),
`payment-deadline.test.ts` (4, env parsing/fallback), `lazy-expiry.test.ts` (3, fire-and-swallow
behaviour), `late-payment-reconciliation.test.ts` (4, the four not-late/late branches),
`architecture.test.ts` (+14: centralized lazy-expiry trigger across every relevant route, no
route asks "is the provider mock/peach" to decide readiness, the internal cron route requires
a configured secret, the deadline duration is read from exactly one config module, plus 9
regression guards reading the migration SQL text directly — the RPC bodies, trigger, and
grants match the documented invariants). `getBookingFinancialEligibility` itself is a thin,
already-tested composition (`loadBookingFinancialState` + `deriveFinancialReadiness`,
Step 5) validated end-to-end via live Scenarios A–D rather than a separate mocked unit test,
matching this codebase's existing convention for orchestrator-layer functions (see
`docs/FINANCIAL_ORCHESTRATION.md` — no DB-mocked unit tests exist for
`authorizeBookingFinancials` either; live validation is the established verification path for
this class of function).

## Scheduler design

No production scheduler is configured this phase. `POST /api/internal/expire-unpaid-bookings`
exists so wiring one later (Vercel Cron or equivalent) needs no new code — only a cron
configuration pointing at this URL with the `INTERNAL_CRON_SECRET` bearer header. Recommended
cadence: every 5–15 minutes.

## Mock-to-Peach compatibility

Unchanged by a future Peach switch: `payment_due_at`/`payment_expired_at` computation, the
`expire_unpaid_accepted_bookings()` RPC, `deriveFinancialReadiness`,
`getBookingFinancialEligibility`, the start-rental gate, both dashboards, availability
release. The expiry RPC's readiness check reads only `payments.status` (already
provider-neutral); nothing about it changes when `PAYMENT_PROVIDER` changes. Only checkout
initiation/callbacks and webhook event mapping are provider-specific, unchanged from Step 5's
own compatibility boundary.

## Known limitations

- No safety buffer before `start_at` in the deadline formula — undocumented anywhere in this
  codebase, so none was added. A booking accepted very close to its own start time gets a
  correspondingly short (or, in a rare edge case where a merchant delays acceptance past a
  booking's `start_at`, already-past) payment window; it self-corrects via the next sweep
  rather than being a broken state, but the UX is poor in that edge case.
- The lazy-expiry trigger performs a full table scan on every trusted read — acceptable at
  MVP scale, not a substitute for the scheduler at production volume (see "Lazy expiry").
- No production scheduler is actually wired up — `INTERNAL_CRON_SECRET` and the route exist,
  cron configuration is deliberately out of scope this phase.
- `record_late_payment_reconciliation` only ever creates the marker — there is no admin UI
  yet to surface `requires_manual_review: true` bookings for review (Step 9 territory).
- Refunds for a late-success-after-expiry payment are explicitly not built — the marker exists
  precisely so this can be handled manually until a real refund flow exists.
