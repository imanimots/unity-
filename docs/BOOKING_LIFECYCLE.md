# Booking Lifecycle (Phase 2B)

MVP booking domain model and rental lifecycle for Unity. This is schema, RPCs, API routes,
and minimal UI — no payments, no disputes, no chat, no reviews. See "Out of scope" at the
end for the full boundary.

## Existing structures discovered and reused

`bookings` and the `booking_status` enum already existed in
`20260613000001_initial_schema.sql`, with 0 live rows. Extended, not replaced:
- `booking_status`: `pending`/`approved` renamed to `requested`/`accepted` (0 rows made this
  safe); added `rejected`, `expired`, `cancelled_by_renter`, `cancelled_by_merchant`,
  `return_pending`, `completed`. `cancelled` and `disputed` are kept but unused by this
  phase's state machine — reserved for a future admin/dispute process.
- `bookings`: five pre-existing NOT NULL columns (`start_date`, `end_date`, `total_days`,
  `rental_fee`, `total_amount`) are superseded by richer snapshot columns and relaxed to
  nullable rather than dropped. Nothing in this phase reads them.
- Two live security gaps found and fixed during the mandatory audit, independent of the new
  feature work:
  - `bookings`' `parties update`/`renter insert` RLS policies had no real `WITH CHECK` —
    either party could directly rewrite status, price, or `merchant_id`/`renter_id` via a
    plain authenticated `UPDATE`. Fixed by dropping both policies; all mutation now goes
    through service-role-only RPCs (matches `submit_listing_for_review`'s existing pattern).
  - `rental-media` storage bucket allowed upload AND read to any authenticated user
    regardless of booking participation — worse than the `listing-media` bug fixed in Phase
    2A. Upload is now folder-scoped like every other private bucket; read is deliberately
    left open for now since no booking-media table exists yet to scope it by (see "Future
    extension points").
- Idempotency reuses `idempotency_keys` (Phase 2A) exactly as-is — its primary-key column is
  named `merchant_id` but is used here as a generic acting-user id for both renter- and
  merchant-initiated operations. Not renamed, to avoid touching already-verified Phase 2A
  RPCs that reference it.
- `listing_availability` (Phase 2A, merchant-blocked date ranges) is checked at booking
  creation. `listing_requirements` (Phase 2A) supplies the terms snapshot.
- `risk_tier` (Phase 1 risk engine) is read-only context, not part of booking logic itself.

## Status model

```
requested → accepted → active → return_pending → returned → completed
   │            │
   ├→ rejected   ├→ cancelled_by_renter / cancelled_by_merchant
   ├→ cancelled_by_renter
   └→ expired
```

| From | To | Actor | Notes |
|---|---|---|---|
| requested | accepted | merchant | own listing only, not expired, race-safe (exclusion constraint) |
| requested | rejected | merchant | any reason |
| requested | cancelled_by_renter | renter | always allowed |
| requested | rejected (system) | system | auto-fired when a conflicting request is accepted |
| requested | expired | system | `expires_at` passed, sweep function |
| accepted | active | renter or merchant | only within the start window |
| accepted | cancelled_by_renter | renter | blocked if `renter_cancellation_notice_hours` window has passed |
| accepted | cancelled_by_merchant | merchant | blocked if `merchant_cancellation_notice_hours` window has passed |
| active | return_pending | renter or merchant | initiates return |
| active | (cancel) | — | not allowed — active bookings need a future admin process (out of scope) |
| return_pending | returned → completed | the *other* party | one RPC call, two history rows |

Merchant cancelling a `requested` booking must use reject, not cancel (enforced by the RPC).
Terminal statuses (`rejected`, `expired`, `cancelled_by_renter`, `cancelled_by_merchant`,
`completed`) never transition further through any RPC in this phase.

## Availability and conflict model

**Chosen policy: only `accepted`/`active` bookings block dates. `requested` bookings do not
reserve dates.** Multiple renters may request overlapping dates; accepting one automatically
rejects any other `requested` booking on the same listing that directly overlaps, with a
system-generated reason and its own history row.

Interval semantics: `[start_at, end_at)` — start inclusive, end exclusive, using UTC
`timestamptz` throughout (no separate timezone column; South Africa runs no DST).

Race safety is a database-level Postgres exclusion constraint
(`bookings_no_overlap_when_blocking`, `btree_gist`), not an application check-then-write:

```sql
exclude using gist (
  listing_id with =,
  tstzrange(start_at, end_at, '[)') with &&
) where (status in ('accepted', 'active'))
```

Live-tested: two `requested` bookings with identical overlapping dates, `accept` fired
concurrently on both. Exactly one succeeded; the other was cleanly auto-rejected (its own
successful sibling's post-accept cleanup ran first) with full history — not a raw constraint
error. The constraint itself is the backstop that guarantees this outcome is possible at all
under true concurrency; the auto-reject logic is what makes the loser's outcome clean instead
of a generic conflict error.

## Price and deposit snapshot

Deterministic, server-side only (`src/lib/bookings/price.ts` for UI preview,
`create_booking_request()` in SQL is authoritative — both implement the identical formula).

- Only `daily_rate` is used. `weekly_rate`/`weekend_rate`/`monthly_rate` exist on listings
  but are **not applied** by either calculator — a deliberate Phase 2B simplification (the
  task didn't specify when a weekly rate should kick in, and guessing that business rule
  felt riskier than being explicit about the gap). Documented here as a known limitation.
- Duration bills in whole days, rounding **up** for any partial day.
- All amounts are `numeric(12,2)` in Postgres; the JS preview rounds to exact cents
  (`Math.round((x + Number.EPSILON) * 100) / 100`) to avoid floating-point display drift.
- `platform_fee_amount` is always `0` — no platform fee is defined anywhere in this codebase
  yet. The column exists for the future.
- `deposit_amount_snapshot` comes from `listings.deposit_amount` when `deposit_required` is
  true. `listing_requirements.final_deposit_amount` (a system-calculated, risk-tier-adjusted
  figure) is never populated by any existing trigger anywhere in this codebase — using it
  would have meant building that calculation now, out of scope for this pass.
- `renter_total_amount` / `merchant_proceeds_estimate` are informational only — **no money is
  collected**. Cancellation responses include `settlement_status:
  "not_applicable_no_payment_collected"` rather than a fabricated refund figure.
- Snapshots are immutable once written — live-verified: editing a listing's `daily_rate` and
  `deposit_amount` after a booking exists leaves that booking's snapshot unchanged.

## Idempotency

Exactly the Phase 2A pattern, not a second implementation: `idempotency_keys` table, request
hash = `md5()` of the operation's stable inputs, checked before the RPC runs. Every mutation
route (`create`, `accept`, `reject`, `cancel`, `start`, `return`, `confirm-return`) reads
`idempotency_keys` via a service-role client *before* any status check that could otherwise
reject an already-completed retry — the same fix already applied to listing submission.
Hashes are computed identically in SQL and TypeScript
(`src/lib/bookings/idempotency.ts`); each formula was cross-verified against a live
`select md5(...)` query, not assumed.

Live-verified: exact retry returns the original result with no duplicate row; changed
payload with the same key returns a 409 conflict; a different actor reusing the same literal
key string creates their own independent booking (no cross-user leak, since the primary key
includes the actor id); replay after the underlying resource reached a terminal state via a
*different* action still returns the original cached result, not an error.

## RLS and RPC trust boundary

`bookings`: `SELECT` policy only (`parties read` — renter or merchant). No `INSERT`/`UPDATE`
policy for `anon`/`authenticated` at all — every mutation goes through a
service-role-only RPC. A `protect_booking_privileged_fields` trigger is additional
defense-in-depth (reverts status/identity/snapshot/timestamp fields for any non-service-role
caller) in case a policy is ever mistakenly reintroduced.

`booking_history`: `SELECT` for parties only. No write policy at all — written exclusively by
the RPCs. `prevent_row_mutation()` (reused from Phase 2A, not duplicated) blocks `UPDATE`/
`DELETE` unconditionally, live-verified to block even a `service_role` attempt.

All 8 RPCs (`create_booking_request`, `accept_booking_request`, `reject_booking_request`,
`cancel_booking`, `start_rental`, `initiate_return`, `confirm_return`,
`expire_stale_booking_requests`) are `SECURITY DEFINER` with `set search_path = public`, an
internal `auth.role() <> 'service_role'` guard, and `EXECUTE` revoked from
`anon`/`authenticated`/`public` — granted only to `service_role`. Verified empirically
against the live database (not assumed from the migration text), and live-tested: direct
calls with a real user JWT return `42501 permission denied` for every one of the 8 functions,
including attempts that pass someone else's user id as the trusted parameter.

Identity is always passed explicitly (`p_renter_id`, `p_merchant_id`, `p_actor_user_id`) from
the calling Next.js route's own verified session (`getRequestProfile()`), never taken from
`auth.uid()` (a service-role session has no user JWT) and never trusted from client input.
`cancel_booking` derives which side the caller is on from the booking row itself
(`renter_id`/`merchant_id` match) rather than accepting a client-supplied role string.

`expire_stale_booking_requests()` has no public HTTP route this phase — it's callable only by
`service_role`, intended to be wired to a future scheduled process. Calling it repeatedly is
safe (a booking already moved out of `requested` is simply not matched again).

## API routes

```
POST   /api/bookings                        create a request           201 / 400 / 401 / 403 / 404 / 409 / 422
GET    /api/bookings?role=&status=          list caller's own bookings
GET    /api/bookings/[id]                   detail + history
POST   /api/bookings/[id]/accept            merchant only
POST   /api/bookings/[id]/reject            merchant only
POST   /api/bookings/[id]/cancel            renter or merchant (role derived server-side)
POST   /api/bookings/[id]/start             renter or merchant
POST   /api/bookings/[id]/return            renter or merchant (initiate)
POST   /api/bookings/[id]/confirm-return    the counterparty to whoever initiated
```

Error mapping (`src/lib/bookings/rpc-errors.ts`) never forwards a raw Postgres error message
to the client — verified with a fallback test asserting a raw constraint-violation message
never leaks through.

## Minimal UI delivered

- `/listings/[id]/book` — request-to-book flow. Rewritten from a pre-existing mock scaffold:
  removed the fake PayFast payment step and escrow copy (payments are out of scope), removed
  a hardcoded fake "unavailable dates" array and mock KYC/score gates driven by
  `localStorage` (misleading now that a real backend exists), wired the price breakdown to
  `calculateBookingPrice()`, wired submission to the real API with a stable idempotency key.
- `/dashboard/renter/bookings` and `/dashboard/merchant/bookings` — rewritten from
  client-side mock-state pages to real server components reading live data, with inline
  status-appropriate action buttons (`src/components/bookings/booking-actions.tsx`).
- Deliberately not built: a separate booking detail page (the list view plus inline actions
  covers every in-scope action; `GET /api/bookings/[id]` exists for future use), any
  media/chat/dispute/review UI (all explicitly out of scope and already had pre-existing
  mock-only pages this phase does not touch).

## Performance (dev environment, not production)

`create_booking_request` via the full route: ~1.1–1.35s. List routes: ~1.0–1.1s. Slower than
Phase 2A's direct-RPC timings (~270–320ms) because these routes chain several sequential
round-trips (`getRequestProfile()`'s own user+profile fetch, service-role client
construction, the idempotency lookup, then the RPC). Not alarming for MVP; flagged as a
genuine, measured observation rather than optimized preemptively. Indexes added on every
documented hot path: `(listing_id, status)`, `(renter_id, status)`, `(merchant_id, status)`,
`start_at`, a partial index on `expires_at` for the requested-only sweep, `booking_reference`,
and `created_at`.

## Payment readiness (Step 6 addendum)

`bookings` gained two columns this phase: `payment_due_at` (set at acceptance) and
`payment_expired_at` (set only by a payment-driven expiry, distinct from the
stale-*request* expiry above). `start_rental` may now also fail with a financial-readiness
gate (checked in the route, not the RPC — the RPC itself is unchanged) and
`expire_unpaid_accepted_bookings()` is a new sweep, separate from
`expire_stale_booking_requests()`, that can additionally move `accepted → expired`. Both
expiries land on the same `expired` status value; only `payment_expired_at` distinguishes
which one fired. Full detail: `docs/PAYMENT_READINESS.md`.

## Affiliate commission (Step 11 Phase 7 addendum)

A successful `rental_charge` payment (never a `deposit` payment) on an affiliate-enabled listing
with a valid, product-specific attribution generates exactly one affiliate commission —
qualification is hooked into the payment orchestrator (`authorize-booking-financials.ts`), never
into any booking-status RPC in this file. See `docs/AFFILIATE_SYSTEM.md`.

## Merchant payout (Step 11 Phase 8 addendum)

A booking reaching `completed` (via `confirm_return()`) triggers a best-effort merchant payout
creation call — never blocking the return confirmation itself. This is a hook into the payment
orchestrator (`create-merchant-payout.ts`), never into `confirm_return()`'s own SQL. See
`docs/MERCHANT_PAYOUT_WORKFLOW.md`.

## Known limitations / future extension points

- Weekly/weekend/monthly rate blending is not implemented — daily rate only.
- `platform_fee_amount` is always 0 — no fee model exists yet.
- Deposit uses the simple `listings.deposit_amount` figure, not a risk-tier-adjusted
  calculation (that trigger doesn't exist anywhere in this codebase).
- `min_age`, `verified_identity_required`, `kyc_approved_required`, licence requirements are
  snapshotted for display but not hard-enforced — there's no birthdate/age data captured
  anywhere on the platform yet, and KYC integration (Sumsub) is out of scope. Consistent with
  how Phase 2A already treats these as warnings, not blockers.
- `rental-media` bucket read access is still open to any authenticated user (only upload was
  scoped this phase) — narrowing it needs a booking-media table that doesn't exist yet.
- No scheduled process actually calls `expire_stale_booking_requests()` yet — the function
  exists and is safe to wire to a cron in a future phase.
- `active` booking cancellation intentionally has no self-service path — explicitly deferred
  to a future administrative process per the task's own scope boundary.

## Out of scope (explicitly not built this phase)

Payment gateway integration, real deposit collection, escrow, insurance claims, damage
assessment, disputes, delivery integrations, chat/messaging, notifications, reviews, admin
moderation UI, analytics, buying & selling, Phase 2B+ (Phase 2C and beyond).
