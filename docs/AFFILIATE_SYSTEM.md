# Product-Specific Affiliate Attribution, Automatic Commissions and Admin Overrides (Step 11 Phase 7)

## What existed before this phase

`listings.accepts_affiliates`/`affiliate_commission_rate` and the listing-wizard "Affiliates" step were already real — per-listing, merchant-set, wizard-enforced 1–50 range. `POST /api/affiliate/activate` (mints `profiles.affiliate_code`) was real. Everything downstream was either missing, mock, or actively insecure:

- **A live, exploitable RLS hole.** `affiliate_referrals`' original `"affiliate_referrals: affiliate insert" with check (affiliate_id = auth.uid())` policy let any authenticated user directly insert an arbitrary, already-`status='paid'` commission row via PostgREST — completely bypassing every application route. Live-tested with a real QA session before this phase's first migration (test row created and immediately cleaned up). Fixed as the very first migration of this phase, per explicit review priority.
- `POST /api/affiliate/referral` trusted a client-supplied `rentalFee` number directly, had no idempotency, never recorded `referred_user_id`, and was never called from any real checkout path — dead, insecure code, not a working integration.
- The `unity_affiliate_ref` cookie held only a single un-scoped affiliate code — structurally incapable of "different listings may use different affiliates" (one cookie key, last write wins across every listing a visitor browses).
- Both affiliate dashboards and `/admin/affiliates` rendered 100% hardcoded mock data.

This phase replaces all of it with real, product-specific, event-based, automatically-processed commissions and narrow admin overrides — no new payment architecture, reusing the existing `PaymentProvider` interface, `idempotency_keys` pattern, and `prevent_row_mutation()` immutable-history pattern.

## Business rules (as implemented)

1. **Affiliate enablement is per-listing, not merchant-wide.** `listings.accepts_affiliates`/`affiliate_commission_rate` (pre-existing) plus new audit columns `affiliate_enabled_at`, `affiliate_enabled_by`, `affiliate_disabled_at`, `affiliate_rate_updated_at`, `affiliate_rate_updated_by`. Every qualification RPC reads the listing's **live** value at qualification time — not a historical snapshot — which is what makes the grandfathering rule (below) actually take effect.
2. **Attribution is product-specific.** One `affiliate_attributions` row per `(referred_user_id, listing_id)` pair, DB-enforced via a unique constraint — "first valid referral wins," permanently, for that customer+listing combination. A different listing from the same merchant may carry a different affiliate's attribution independently.
3. **Buy/sell commission is a single once-off commission** per sale, computed from the order's own immutable `total_amount` minus `shipping_fee` (non-commissionable). Never recomputed on status refresh, webhook replay, or admin reopening — enforced by a DB-level `unique(payment_id)` constraint on `affiliate_commissions`, not just application logic.
4. **Rental commission is event-based**, keyed on the specific qualifying `payment_id` (the `rental_charge` payment), never on the booking as a whole. Deposits never qualify — they are a different `payment_type` and structurally excluded, not filtered by a runtime check. One payment event produces at most one commission (same DB-level `unique(payment_id)` constraint).
5. **Barter never generates commission.** No barter completion code path calls either qualification RPC (confirmed by repo-wide search — see "Barter guard" below), and both RPCs' own parameter shapes have no way to accept a barter agreement reference at all.
6. **Processing is automatic by default.** Qualification happens synchronously inside the payment orchestrator (best-effort, never blocking); review, approval, payout-queueing, provider payout, and refund reconciliation run as bounded internal cron jobs.
7. **Admin overrides are narrow and reason-mandatory.** Hold, release, void, retry, manual mark-paid, and append-only adjustment — never a direct edit of the original commission's base/rate/amount/affiliate/customer/merchant/listing/payment reference.

## Schema

10 migrations, dependency-ordered, enum `ADD VALUE` isolated per this project's established convention:

1. `20260819000001_affiliate_referrals_rls_fix.sql` — drops the vulnerable insert policy. Applied first, alone.
2. `20260819000002_affiliate_commission_status_enum.sql` — `affiliate_commission_status`: `pending, held, approved, payout_queued, processing, paid, failed, voided, reversed`.
3. `20260819000003_affiliate_attributions_restructure.sql` — renames `affiliate_referrals` → `affiliate_attributions` (0 live rows, confirmed safe to restructure). Drops the old `commission_amount`/`status`/`booking_id`/`order_id` columns. Adds `merchant_id`, `referral_code`, `attributed_at`, `expires_at`, `consumed_at`, `source` (`'cookie'|'direct_link'`), a new `status` (`'active'|'expired'|'consumed'|'blocked'`). `referred_user_id`/`listing_id` become `NOT NULL`. `unique(referred_user_id, listing_id)` — the DB-level "first valid referral wins" guarantee. RLS: affiliate reads own rows, merchant reads rows for own listings, **zero client write policies**.
4. `20260819000004_affiliate_commissions.sql` — one row per qualifying payment event: `attribution_id, transaction_type ('sale'|'rental'), order_id, booking_id, payment_id (unique), listing_id, merchant_id, affiliate_id, referred_user_id, eligible_base, commission_rate, commission_amount, currency, calculation_version, status, payout_provider, payout_provider_reference, payout_requested_at, payout_confirmed_at, hold_reason, void_reason, approved_at, created_at, updated_at`. Two-way exactly-one-of CHECK on `order_id`/`booking_id`. `unique(payment_id)`. RLS: affiliate/merchant read only.
5. `20260819000005_affiliate_commission_history.sql` — append-only, `prevent_row_mutation()` reused.
6. `20260819000006_affiliate_commission_adjustments.sql` — append-only, same trigger. The only way to record a correction without touching the original row.
7. `20260819000007_listings_affiliate_audit_columns.sql` — adds the 5 audit columns above. Also `CREATE OR REPLACE save_listing_draft()` with a server-side `least(greatest(rate, 0), 50)` clamp on `affiliate_commission_rate` (previously only client-enforced).
8. `20260819000008_affiliate_rpcs.sql` — all commission/attribution RPCs (see below).
9. `20260819000009_email_entity_widening_affiliate.sql` — widens `email_deliveries.related_entity_type` to add `'affiliate_commission'` and `'profile'` (the latter for user-level events with no listing/transaction context, e.g. `affiliate.enrolled`).
10. `20260819000010_affiliate_overview_stats.sql` — `CREATE OR REPLACE get_admin_overview_stats()`, adds `affiliate_commissions_pending`, `affiliate_commissions_held`, `affiliate_commissions_payout_queued`, `affiliate_commissions_failed`, `active_affiliates`.

**Legacy columns left in place, untouched, unused:** `bookings.affiliate_id`/`affiliate_commission_amount` and `orders.affiliate_id`/`affiliate_commission_amount` — single-value columns from a superseded "one global commission per transaction" model, incompatible with the event-based per-payment model this phase requires. Dropping them would be an unnecessary destructive migration; they are documented as superseded, matching the `evidence_urls` precedent from Phase 2.

## RPCs

All `SECURITY DEFINER`, service-role-only (`auth.role() <> 'service_role'` hard-blocked), idempotency-keyed via the existing `idempotency_keys` table, actor identity always derived from the row/session context never a client parameter.

- `open_affiliate_attribution` — creates an attribution row for an authenticated user + listing + referral code; a second call for the same `(referred_user_id, listing_id)` pair is a no-op success (the unique constraint), not an error.
- `qualify_sale_affiliate_commission(p_order_id, p_payment_id, p_idempotency_key)` — called from the order payment orchestrator after capture succeeds.
- `qualify_rental_payment_affiliate_commission(p_booking_id, p_payment_id, p_idempotency_key)` — called from the booking payment orchestrator after capture succeeds.
- `progress_affiliate_commission` — pending → approved (or → held if a blocking condition exists).
- `queue_affiliate_payout` — approved → payout_queued.
- `mark_affiliate_commission_processing` / `record_affiliate_payout_result` — payout_queued → processing → paid/failed.
- `retry_affiliate_payout` — admin-only, failed → payout_queued.
- `hold_affiliate_commission` / `release_affiliate_commission_hold` — admin-only, reason mandatory on hold.
- `void_affiliate_commission` — admin-only, reason mandatory.
- `create_affiliate_commission_adjustment` — admin-only, append-only correction record, reason mandatory.
- `mark_affiliate_commission_paid_manually` — admin-only, records a real out-of-band payout.
- `enable_listing_affiliate` / `disable_listing_affiliate` — merchant-owner (or admin override), writes the audit columns.

A shared internal helper, `_affiliate_commission_transition()`, locks the row, validates the allowed-from-status array, and writes the immutable history row with the true previous status (captured from the initial locking `SELECT`, before the transition — not re-derived after the update).

## Commission calculation

`commission_amount = round(eligible_base × commission_rate / 100, 2)`, using Postgres `numeric` throughout — never floating point. Every commission row snapshots: `eligible_base`, `commission_rate`, `commission_amount`, `currency`, `listing_id`, `merchant_id`, `affiliate_id`, `referred_user_id`, the transaction id (order or booking), `payment_id`, and `calculation_version` (starts at `1`, bumped only if the formula itself changes — historical rows stay interpretable forever). The browser never calculates or submits any of these values; both qualification RPCs re-derive everything server-side from the listing's live rate and the payment's own amount.

**Rate source.** Only one real rate tier exists in this codebase — `listings.affiliate_commission_rate`, wizard-set per listing. No merchant-level or platform-default rate exists anywhere. Rather than inventing the spec's suggested 3-tier fallback against a business model that only supports one tier, the listing's own rate is the sole source.

## Attribution model and cookie

**"Product-specific first-valid attribution."** For a given customer + listing, the first valid referral wins permanently — a later affiliate link for the same listing does not overwrite it, the customer cannot change it, the merchant cannot reassign it. Attribution for a different listing (even from the same merchant) is entirely independent.

`unity_affiliate_ref` was redesigned from a single code string to a JSON payload keyed by listing id: `{ "<listingId>": { "code": "AFC-XXXX", "capturedAt": "<iso>" } }`, capped at the 20 most-recently-visited listings (oldest evicted on overflow). One central helper, `src/lib/affiliate/cookie.ts`, owns capture/parse/validate/upsert/consume/clear — no call site re-implements cookie parsing. `Path=/`, `SameSite=Lax`, `Secure` in production, 30-day `Max-Age`. The cookie never carries commission rate, amount, PII, banking info, or auth credentials — only a code, listing id, and timestamp.

**Persistence timing.** `POST /api/affiliate/attribution` is called once, client-side, the first time an *authenticated* user loads a listing page carrying a valid, not-yet-consumed cookie entry for that listing. Persisting at first opportunity (not deferred to checkout) is what makes "attribution after checkout/payment begins is rejected" enforceable — `attributed_at` is compared server-side against the transaction's own start time. An anonymous visitor's cookie entry is simply picked up later, the first time they authenticate and revisit that listing page; no anonymous-attribution row is ever created.

**Known limitation, stated up front:** the cookie cannot be `HttpOnly`, since capture happens in a client component reacting to a `?ref=` query param on page load (the existing pattern this phase inherited). Mitigated by never storing anything sensitive in it and always re-validating server-side — a forged/tampered cookie value can only ever point at a real, active affiliate code, which the server independently re-verifies against `profiles.affiliate_code`.

## Grandfathering rule (approved)

Disabling affiliates on a listing:

1. Blocks all **new** attribution for that listing immediately.
2. Blocks qualification of any payment event occurring **after** the disable timestamp, from that point forward — enforced by every qualification RPC reading the listing's live `accepts_affiliates` value at qualification time, not a historical snapshot.
3. **Never touches, voids, or reduces** any commission row that already existed at the moment of disable — it continues through its normal lifecycle unaffected.

No special-case carve-out beyond this. There is currently only one qualifying payment event per booking/order in the live product (no rental extensions or recurring charges exist yet — see "Known limitations"), so in practice this rule's main effect today is on *future* payment events on a feature that doesn't exist yet; the architecture is ready for it regardless.

## Barter guard

Both qualification RPCs' parameter lists have no shape that could accept a barter agreement reference — there is structurally no argument that could route a barter transaction through them, not merely a runtime check that could be bypassed. No barter completion code path (`confirm_barter_completion`, `mark_barter_progress`, `cancel_barter_agreement`, or their route wrappers) calls either RPC — confirmed by repository-wide search. `scripts/verify-affiliate-system.mjs` Scenario E asserts both: a completed barter fixture never produces a commission row, and a direct RPC call attempting to reference a barter agreement id is rejected as an order/booking not found.

## Automatic lifecycle

Five bounded internal jobs, `INTERNAL_CRON_SECRET`-gated, mirroring the existing `/api/internal/expire-unpaid-bookings` pattern:

| Route | Transition |
|---|---|
| `POST /api/internal/affiliate/review-and-approve` | `pending` → `approved` once past the review window and no blocking flag; → `held` if one exists |
| `POST /api/internal/affiliate/queue-payouts` | `approved` → `payout_queued` |
| `POST /api/internal/affiliate/process-payouts` | `payout_queued` → `processing` → `paid`/`failed`, via `provider.createAffiliatePayout()` |
| `POST /api/internal/affiliate/reconcile-refunds` | A captured payment behind an unpaid commission that later shows `refunded`/`partially_refunded` → void automatically; if already paid → exception raised, never a silent rewrite |

Each job processes a bounded batch (`limit 100`) and is idempotent — re-running finds nothing new to do. **No route ever marks a commission `paid` without a real, confirmed provider result** — if no provider is configured, processing stops at `payout_queued`/`approved` and surfaces an exception rather than fabricating success.

`PaymentProvider.createAffiliatePayout()` is a new method on the existing interface (no parallel abstraction). `MockProvider` implements it deterministically (`mockScenario === 'declined'` → failed, otherwise paid, `mock_affiliate_payout_*` reference prefix) — the same mock/provider-neutral pattern every other financial domain in this codebase uses at this stage. `PeachPaymentsProvider` stubs it with `NotImplementedError`, matching its other unimplemented methods.

Manual invocation (no Vercel cron wiring exists yet for these routes — documented in `docs/PUBLIC_TEST_RUNBOOK.md`):

```
curl -X POST https://<host>/api/internal/affiliate/review-and-approve -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
curl -X POST https://<host>/api/internal/affiliate/queue-payouts -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
curl -X POST https://<host>/api/internal/affiliate/process-payouts -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
curl -X POST https://<host>/api/internal/affiliate/reconcile-refunds -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
```

## Idempotency

Every mutating RPC accepts and checks an idempotency key via the standard `idempotency_keys` check-then-insert wrapper. **Database-level uniqueness is the authoritative guarantee, not just the route/RPC-level check:** `affiliate_commissions.payment_id` is `unique` — one qualifying payment can produce at most one commission row regardless of any application-level bug, satisfying "do not rely only on route-level checks" directly. `affiliate_attributions(referred_user_id, listing_id)` is similarly unique at the DB level.

## Admin overrides

Six routes under `/api/admin/affiliate-commissions/[id]/`: `hold`, `release`, `void`, `retry`, `mark-paid`, `adjust`. Every one: `requireAdminForRoute()`, server-derived admin id, mandatory `reason` field (rejected if missing/blank), idempotency-keyed, validates the current status before transitioning (stale-state mutation rejected), writes one `affiliate_commission_history` row with the true previous/new status.

**No route can touch** `commission_amount`, `commission_rate`, `eligible_base`, `affiliate_id`, `referred_user_id`, `merchant_id`, `listing_id`, or `payment_id` on an existing row — those columns have no admin-facing update path anywhere, by construction. A correction is either a `void` (with reason) or a new `affiliate_commission_adjustments` row (append-only, its own signed amount, reason, admin id) — never an `UPDATE` of the original row's financial fields.

## Immutable history

`affiliate_commission_history`: `commission_id, attribution_id, listing_id, payment_id, previous_status, new_status, actor_type ('system'|'admin'), actor_id, reason, calculation_snapshot, provider_reference, idempotency_key, created_at`. `prevent_row_mutation()` (the same trigger every other domain's history table uses) blocks any `UPDATE`/`DELETE`, including by a service-role connection outside the defined RPC paths.

## Anti-fraud

Enforced as hard blocks (not fuzzy scoring or fingerprinting) inside `open_affiliate_attribution`/the qualification RPCs: self-referral (affiliate = referred user), merchant self-referring on their own listing (via any account), attribution attempted after the transaction has already started, an inactive/disabled affiliate code, a listing with affiliates currently disabled, a forged listing/payment/order/booking reference (the RPC's own `SELECT ... WHERE id = ... AND listing_id = ...`-shaped lookups simply find nothing and raise), a refunded/failed payment (never qualifies), and the `unique(payment_id)`/`unique(referred_user_id, listing_id)` constraints preventing duplicate attribution or duplicate commission outright.

## Dashboards

- **Affiliate dashboard** (`/dashboard/affiliate`) — real data from `GET /api/affiliate/me`, `GET /api/affiliate/listings`, `GET /api/affiliate/commissions`. Barter-only-context listings never appear (the existing `listing_type IN ('rental','sale','both')` eligibility gate already excludes anything that isn't rentable/sellable). Customers are shown anonymised (first name + last initial), matching the existing review-display precedent elsewhere in the codebase.
- **Merchant dashboard** (`/dashboard/merchant/affiliates`) — real data from `GET /api/affiliate/merchant-listings` (scoped strictly to `merchant_id = requester.userId`), per-listing enable/disable toggle wired to `POST /api/listings/[id]/affiliate/{enable,disable}`.
- **Admin** (`/admin/affiliates`, `/admin/affiliates/[id]`, `/admin/affiliate-commissions`, `/admin/affiliate-commissions/[id]`) — mirrors `/admin/orders`'s list/detail shape exactly. Filters: affiliate, merchant, listing, transaction type, status, search. Override buttons on the detail page prompt for a mandatory reason (and amount, for an adjustment) before calling the corresponding admin route.

## CSV export

`AFFILIATE_COMMISSION_CSV_COLUMNS` (`src/lib/admin/affiliate-service.ts`): affiliate/merchant *display names* (never raw ids or email), listing reference, transaction type, order/booking reference, commission base/rate/amount, currency, status, payout status, timestamps, void/override reason. No personal identity numbers, addresses, bank details, payment credentials, KYC documents. `toCsv()`'s shared `escape()` function (used by every domain's CSV export, not just this one) now prefixes any cell value starting with `=`, `+`, `-`, `@`, a tab, or a carriage return with a literal `'` — a real, general spreadsheet-formula-injection fix found and fixed while building this export, benefiting every existing CSV export in the admin area.

## Exception queue

8 new categories in `src/lib/admin/exceptions-service.ts`: `affiliate_commission_pending_stale`, `affiliate_commission_held_stale`, `affiliate_commission_approved_not_queued`, `affiliate_commission_payout_stuck`, `affiliate_commission_payout_failed`, `affiliate_commission_provider_result_not_reconciled`, `affiliate_commission_paid_then_refunded`, `suspended_affiliate_with_open_commissions`. "Successful eligible payment missing a commission" was deliberately **not** built as a live-computed category — it would require an expensive 3-way join across payments/orders/bookings on every admin page load; genuine misses are already logged via the qualification calls' own best-effort `console.error` on failure, and can be investigated from application logs without a standing exception category.

## Emails

10 new catalogue entries: `affiliate-enrolled`, `affiliate-commission-approved`, `affiliate-commission-held`, `affiliate-payout-queued`, `affiliate-commission-paid`, `affiliate-payout-failed`, `affiliate-commission-voided` (requires `voidReason`), `affiliate-adjustment-created` (requires `adjustmentAmount`), `merchant-affiliate-enabled`, `merchant-affiliate-disabled`.

Three spec candidates were consolidated away, each with a stated reason: **`affiliate.commission_pending`** — too early/noisy to be useful before a commission has even cleared review; the dashboard already reflects `pending` state in real time. **`affiliate.listing_link_ready`** — redundant with the dashboard, which already shows exactly which listings are link-ready the moment they're enabled. **`merchant.affiliate_commission_created`** — would fire once per completed sale for a merchant with many affiliate-driven sales, an excessive-notification pattern this codebase's email architecture explicitly avoids elsewhere.

`src/lib/email/context.ts` gained `loadAffiliateCommissionEmailContext()`/`loadAffiliateListingEmailContext()`. `src/lib/affiliate/notify.ts`'s `notifyMerchantOfAffiliateEvent()` takes a caller-supplied `occurrenceKey` (the route's own idempotency key), never a self-generated timestamp — a self-generated key would defeat route-retry idempotency by minting a different key on every retry.

## Security

- `affiliate_attributions`/`affiliate_commissions`/`affiliate_commission_history`/`affiliate_commission_adjustments` all ship with **zero client write policies** — every mutation is RPC-mediated, matching `barter_agreements`/`disputes`/`orders`' fully-gated model.
- Every qualification/mutation RPC is `SECURITY DEFINER` and hard-blocks any caller that isn't the service role.
- Forged listing/order/booking/payment ids behave like every other forged id in this codebase — the lookup simply finds nothing and the RPC raises, indistinguishable from a nonexistent reference.
- The browser never supplies amount, rate, affiliate id, merchant id, or listing-merchant identity — every value is server-derived.
- `POST /api/affiliate/referral` (the old, insecure, client-trusting route) is retired as a permanent `410 Gone` stub rather than a silent removal, so any stale client reference fails loud and clear.
- CSV export excludes every sensitive field named above, plus formula-injection protection.
- Cross-affiliate and cross-merchant reads are blocked by RLS (affiliate-own-rows / merchant-own-listings only).

## Known limitations (stated up front)

- **No rental extensions or recurring rental payments exist anywhere in this codebase today** — `authorizeBookingFinancials()` makes at most 2 provider calls per booking, ever (one `rental_charge`, one optional `deposit`). The commission engine is built generically keyed on `payment_id` so it requires zero further changes whenever a future phase adds extensions/recurring charges — but until then, there is only ever one rental commission per booking.
- **No real payout provider** — mock-only, matching every other financial domain in this codebase at this stage. `PeachPaymentsProvider.createAffiliatePayout()` throws `NotImplementedError`.
- **The affiliate cookie cannot be `HttpOnly`** (see "Attribution model and cookie" above) — mitigated, not eliminated, by never storing sensitive data in it and always re-validating server-side.
- Legacy single-value `affiliate_id`/`affiliate_commission_amount` columns remain on `bookings`/`orders`, unused, documented as superseded rather than dropped.

## Tests

66 unit tests across `src/lib/affiliate/__tests__/{commission-calc,cookie,rpc-errors,idempotency,status-labels,validation,notify}.test.ts` plus `src/lib/admin/__tests__/affiliate-service.test.ts` and the 3 new formula-injection tests in `src/lib/admin/__tests__/csv.test.ts`.

## Live validation: `scripts/verify-affiliate-system.mjs`

Permanent regression script, same safety gate and fixture convention as every prior phase's script (`QA_SEED_ENABLED`/`QA_SEED_CONFIRM`/`QA_SEED_PROJECT_REF`, `[QA]`-prefixed fixture listings, fixed idempotency keys where safe to replay). Covers Scenarios A–H: listing enablement (including a blocked cross-merchant enable attempt); product-specific attribution (first-valid-wins, per-listing independence); sale commission (amount correctness, exact-replay dedup); rental payment commission (deposit never qualifies, exact-replay dedup); barter (zero commission rows, direct RPC rejection, barter listings never surfaced as affiliate opportunities); automation (full pending→approved→payout_queued→paid sweep, a forced-decline→failed→admin-retry path, "never paid without a real provider result"); admin override (hold/release/void/retry/adjust, mandatory reason, non-admin blocked, stale-state rejected, history is append-only and immutable); security (self-referral, merchant self-referral, forged listing/payment ids, the retired `/api/affiliate/referral` route returning 410, direct RLS-blocked table inserts, cross-affiliate/cross-merchant reads blocked, direct non-service-role RPC calls blocked).

Requires QA accounts `affiliateA`/`affiliateB` (added to `scripts/qa-seed.mjs`'s roster this phase) in addition to the existing roster.

## Documentation

This file. `docs/ADMIN_OPERATIONS.md`, `docs/TRANSACTIONAL_EMAILS.md`, `docs/BOOKING_LIFECYCLE.md`, `docs/BUYING_SELLING.md`, `docs/BARTER_EXECUTION.md`, `docs/PAYMENT_ARCHITECTURE.md`, `docs/FINANCIAL_ORCHESTRATION.md`, and `docs/PUBLIC_TEST_RUNBOOK.md` all received narrow, pointer-level updates — see each file's own changelog-style addition near its relevant section.
