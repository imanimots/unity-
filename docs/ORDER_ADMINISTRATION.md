# Order Administration and Order Emails (Step 11 Phase 6)

## What existed before this phase

Orders (buy/sell) have had a real, working transaction engine since Step 7 — the `orders` table, 5 RPCs (`create_order`, `mark_order_paid`, `mark_order_shipped`, `confirm_order_delivery`, `cancel_order`), an `order_history` audit table, and a real `PaymentProvider`-backed single-step checkout (`chargeOrderPayment()`). None of it had admin visibility: no `/admin/orders`, no order exception categories, no order counts on the admin overview, no order transactional emails, and `listFinancialOperations()` (the shared financial-monitoring feed) was order-blind — an order-linked payment row rendered with a silent null booking reference.

This phase adds a monitoring, exception, audit, export, and email layer on top of the existing engine. **The order lifecycle itself is untouched** — no RPC in this phase changes what an order can do or how it gets there.

## Architecture

Reuses the admin-domain pattern proven three times already (disputes → barter → this): `src/lib/admin/orders-service.ts` exports plain functions (`listAdminOrders`, `getAdminOrderDetail`, `exportAdminOrdersCsv`) — one base query + `Promise.all` of related-table lookups + in-memory joins + in-memory search filter, no service class. Routes (`GET /api/admin/orders`, `GET /api/admin/orders/[id]`) use the same `requireAdminForRoute()`/`getAdminServiceClient()`/`isValidUuid()` skeleton every other admin route uses. UI mirrors `/admin/barter`'s list page and `/admin/disputes/[id]`'s detail-page composition exactly.

**This phase is read-only monitoring.** There is no admin mutation surface for orders — no existing safe RPC exists for an order-lifecycle admin override (unlike barter, which already had `admin_cancel_barter_agreement`/`admin_set_barter_hold`), so none was added. `/admin/orders/[id]` links out to the existing dispute admin page and email-delivery admin page for anything actionable.

## Known limitations (stated up front, not discovered at the end)

- **`order_status` has no `'completed'` value.** The enum is `pending, paid, shipped, delivered, disputed, cancelled` — `'delivered'` is the terminal success state. Every "completed"-shaped requirement (the consolidated `order.delivered` email, the overview/exception metrics) maps onto `'delivered'`, not an invented state.
- **Order payout status is always "not applicable."** `merchant_payouts` has no `order_id` or `payment_id` column at all — it is purely booking-scoped today. Rather than querying a table that can never match an order row, the admin detail service and `listFinancialOperations()` both hardcode `payoutStatus: 'not_applicable'` for an order-linked row and never issue the query. Real order-linked payout tracking is a future, Phase-8-adjacent concern — out of scope here (real merchant payouts are explicitly excluded from this phase).
- **Order payment-failure monitoring uses one "failed" category, not a retryable/terminal split.** Bookings get that split because `financial_workflows.status` genuinely stores it. Orders have no workflow table — `chargeOrderPayment()` is a single-step charge with no resumable multi-step model — so there is no durable retryable/terminal distinction to surface. This is a real architectural difference between the two payment flows, not an oversight.
- **`payment_attempts.failure_code` is only populated for the `provider_declined` path.** A provider-level exception thrown before `record_payment_attempt` is reached (a timeout, a retryable provider error) currently records no attempt row at all in `chargeOrderPayment()` — a narrow, pre-existing gap shared with booking's own charge flow. This phase surfaces the normalized code where it exists; it does not expand attempt-recording completeness generally.
- **`orders` has no `listing_title` snapshot.** `unit_price`, `total_amount`, `shipping_fee`, and `quantity` are genuinely immutable (snapshotted at `create_order()` time, hard-protected from later mutation by `protect_order_privileged_fields_trg`). The listing's *title*, however, is always a live lookup through `listing_id` — a seller renaming or deactivating the listing after the sale changes what an old order's email or admin record displays. This is identical to `loadBookingEmailContext()`/`loadBarterEmailContext()`'s own pre-existing behavior, not a new gap.
- **"Delivery method" is a listing-level capability hint, not a per-order recorded choice.** `orders` has no `delivery_method`/`delivery_address` column and no separate shipping table — only listing-level flags (`shipping_payer`, `delivery_available`, `merchant_delivery_available`). The admin detail page displays these as an informational hint, never as a fact about what this specific order will do.

## Admin monitoring (Part A/B)

`/admin/orders` — list with search (order reference, listing title, buyer/seller name), status filter, disputed-only filter, CSV export. `/admin/orders/[id]` — ORDER, FINANCIALS, HISTORY, DISPUTES, MESSAGES, EMAILS, and PARTICIPANTS sections, exactly matching the spec's required layout.

**FINANCIALS** shows the order's single `order_payment`-type payment row (`payments.order_id` + `payments_order_type_unique unique (order_id, payment_type)` — an order only ever has one payment intent, unlike barter's two-sided deposits), its attempts/events, a ledger-entry count (queried via `ledger_entries.payment_id`, found through the order's own payment row — `ledger_entries` has no `order_id` column, only `payment_id`), and the always-`'not_applicable'` payout status.

**MESSAGES** embeds the shared `ChatThread` component directly (`transactionType="order"`, `canSend={false}`, `useAdminEndpoint`) — the same zero-new-code reuse already proven on the dispute admin detail page. Every admin view of order messages resolves through the audited `GET /api/admin/messages`, which writes a row to `admin_message_access_log` before returning data — never a direct query, never the participant endpoint.

## Financial-operations fix (Part E)

`listFinancialOperations()` (`src/lib/admin/operations-service.ts`) was extended, not forked. Its base query now selects `order_id, orders(order_reference)` alongside the existing `booking_id, bookings(booking_reference)` (nullable side-by-side, exactly one populated per row). For an order-linked row: `workflowStatus` stays `null` (no workflow table applies to a single-step charge), `failureCategory` is derived directly from `payment.status === 'failed'` (the honest single category from the known-limitations section above), and `payoutStatus` is the literal `'not_applicable'`, never queried. `AdminFinancialRow.bookingId`/`bookingReference` are now nullable to make room for the new `orderId`/`orderReference` fields — the `/admin/financial-operations` page's "Booking" column was renamed "Reference" and now falls back to whichever of the two is populated.

## Exception categories (Part F)

7 categories, not the spec's 11 candidates — 4 were deliberately dropped, each for a stated reason:

| Category | Trigger |
|---|---|
| `order_awaiting_payment_too_long` | `status='pending'` for over 48h |
| `order_payment_failed` | An `order_payment`-type payment is `'failed'` and the order is still `'pending'` |
| `order_paid_awaiting_shipment_too_long` | `status='paid'` for over 48h |
| `order_shipped_awaiting_delivery_too_long` | `status='shipped'` for over 48h |
| `order_disputed` | `status='disputed'` |
| `order_cancelled_with_unresolved_payment` | `status='cancelled'` but its payment is still `authorised`/`captured` — no automatic refund exists |
| `suspended_account_with_open_order` | A suspended user is buyer or seller on a `pending`/`paid`/`shipped` order |

Dropped, with reasons: **"completed order with unresolved payout"** — no schema support, `merchant_payouts` has no order linkage at all; **"inconsistent order/payment state"** — too vague to define without duplicating the failure/cancellation categories already kept; **"failed order email"** — already fully covered by the existing, entity-type-generic `email_delivery_failed` category (`email_deliveries.related_entity_type` already includes `'order'`); the retryable/terminal split of "order payment failure" collapses into the one `order_payment_failed` category (no stored distinction to split on).

## Admin overview (Part G)

5 counts appended to `get_admin_overview_stats()` (migration `20260818000001_order_overview_stats.sql`, a straight `CREATE OR REPLACE`): `orders_awaiting_payment`, `orders_paid_awaiting_shipment`, `orders_shipped_awaiting_delivery`, `orders_disputed`, `orders_payment_failed`. No payout metric — same reasoning as the dropped exception category above.

## CSV export (Part H)

`GET /api/admin/orders?format=csv`, safe fields only: order reference, listing title, buyer/seller *name* (never email), status, payment status, financial readiness, total amount, currency, created date, last lifecycle event, disputed flag. No email addresses, no KYC document fields, no addresses, no provider payloads, no payment secrets, no banking details.

## Order email catalogue (Part I)

10 templates covering 6 consolidated events — not the spec's 12 candidates. `eventType` and `templateId` are kept deliberately distinct: every 2-template event dispatches the *same* `eventType` with two different `templateId`s (one per audience), never a second event invented merely because the wording differs, mirroring `booking.requested`'s existing `booking-requested-renter`/`booking-request-received-merchant` split.

| Event | Templates | Recipients |
|---|---|---|
| `order.created` | `order-created-buyer`, `order-received-seller` | buyer + seller |
| `order.payment_received` | `order-payment-received-buyer`, `order-payment-received-seller` | buyer + seller |
| `order.shipped` | `order-shipped-buyer` | buyer only |
| `order.delivered` | `order-delivered-buyer`, `order-delivered-seller` | buyer + seller |
| `order.cancelled` | `order-cancelled-buyer`, `order-cancelled-seller` | buyer + seller |
| `order.payment_failed` | `order-payment-failed-buyer` | buyer only |

Three spec candidates were folded away, each with a stated reason: **`order.payment_required`** — for an order (unlike a booking), creation and "payment is now required" are the same moment; `order.created`'s own CTA already says "Pay now," a second email a moment later would be pure duplication. **`order.payment_declined`/`order.payment_failed_retryable`** — collapse into the single `order.payment_failed` template (see the known-limitations section: there is no stored distinction to word two different emails around, and the buyer already got synchronous UI feedback at the moment of checkout). **`order.dispute_opened`/`order.dispute_resolved`** — dropped entirely; `dispute.opened`/`dispute.resolved` (Phase 2) already fire for any transaction type including orders, the same reasoning Phase 4 used to skip a separate `barter.disputed` email.

`src/lib/email/context.ts` gained `loadOrderEmailContext()`, mirroring `loadBarterEmailContext()`'s shape. `src/lib/orders/notify.ts`'s `notifyOrderParties(admin, orderId, eventType, recipients, extraVars?)` takes `recipients: Array<{role: 'buyer' | 'seller', templateId: string}>` — resolved to real `buyer_id`/`seller_id` from the order row itself, never a caller-supplied user id.

## Event wiring (Part J)

All 5 order lifecycle routes dispatch after their RPC/orchestrator call succeeds, wrapped so an email failure never affects the route's response (matching the established `try { await notify... } catch (emailErr) { console.error(...) }` pattern used by every prior domain):

- `POST /api/orders` → `order.created` (buyer + seller)
- `POST /api/orders/[id]/checkout` → `order.payment_received` (buyer + seller) on success; `order.payment_failed` (buyer only) on a **confirmed payment-layer failure only** — `err.code IN ('provider_declined', 'terminal_provider_error', 'retryable_provider_error', 'provider_timeout')`. `internal_consistency_error` is explicitly excluded: it means the payment itself *succeeded* but the subsequent `mark_order_paid` call failed — sending "your payment failed" for that case would be actively wrong. Every request-layer failure (auth, validation, rate limit, not-found, wrong-buyer, not-`pending`) returns before `chargeOrderPayment()` is ever called, so none of those paths are anywhere near the dispatch call.
- `POST /api/orders/[id]/ship` → `order.shipped` (buyer only)
- `POST /api/orders/[id]/confirm-delivery` → `order.delivered` (buyer + seller)
- `POST /api/orders/[id]/cancel` → `order.cancelled` (buyer + seller)

Every dispatch uses a deterministic `occurrenceKey` (`order-${orderId}-${eventType}-${userId}`) — exact route replay (a legitimate idempotent retry landing on `chargeOrderPayment()`'s own early-return-if-already-captured path, for example) calls `notifyOrderParties()` again, but `sendTemplate()`'s own idempotency key (derived from `eventType` + `relatedEntityId` + `recipientUserId` + `templateVersion` + `occurrenceKey`, all identical across the replay) hits the same unique constraint and is skipped as a duplicate — verified live by `scripts/verify-order-administration.mjs`.

## Failure category normalization (Part E / correction 13)

`OrchestrationErrorCode` (`src/lib/payments/orchestrator/errors.ts`) is the existing, closed vocabulary reused for admin display — never reinvented. `charge-order-payment.ts`'s `record_payment_attempt` call now passes `p_failure_code: 'provider_declined'` on the one classified failure path that reaches it (the RPC already accepted this parameter; `chargeOrderPayment()` simply never passed it before this phase). Every admin/CSV/email surface displays only the normalized code (or a generic `'unknown_failure'` label when absent) plus a short static label — **never** `payment_attempts.failure_message`/`payments.failure_reason` free text, which is excluded from CSV exports, admin tables, and emails entirely.

## Security (Part L)

`requireAdminForRoute()` blocks anonymous/non-admin on both new admin routes. Admin service functions only ever run against the service-role client — never reachable by an ordinary authenticated user, since the route itself gates on admin role first. Ordinary users querying `orders`/`payments` directly remain scoped by the existing, unchanged RLS. A forged order id 404s. No mutation is reachable via the admin list/detail routes (both are GET-only by construction). CSV export excludes sensitive fields. Email recipients are always derived from `loadOrderEmailContext()`'s server-side profile lookups, never a client-supplied value. Email replay is idempotent. Raw provider/failure text never reaches an admin-facing surface.

## Tests

Unit tests: `src/lib/admin/__tests__/orders-service.test.ts` (financial-readiness/delivery-hint derivation, CSV column safety), `src/lib/orders/__tests__/notify.test.ts` (role resolution, event/template identity separation, occurrenceKey determinism, extraVars merging, silent skip on a missing order).

## Live validation: `scripts/verify-order-administration.mjs`

Permanent regression script (same safety gate and fixture convention as `verify-dispute-locking.mjs`/`verify-barter-execution.mjs`), covering: full lifecycle admin monitoring + all 6 email events + exact-replay dedup + "delivered cannot be shipped again" + financial-operations correctness; cancellation emails + "cancelled cannot be paid/shipped"; payment failure — order stays `pending`, single `order.payment_failed` email, normalized failure category, exception queue surfaces it, and the order remains payable on retry; a disputed order rejects cancel/ship/deliver and surfaces its dispute link in the admin detail page; security (anonymous/non-admin blocked, forged/malformed ids rejected, no mutation reachable, CSV excludes sensitive fields, admin message reads are audited).

## Documentation

This file. `docs/TRANSACTIONAL_EMAILS.md` and `docs/ADMIN_OPERATIONS.md` were updated with pointers to the sections above; `docs/BUYING_SELLING.md` got a one-line pointer to this document.
