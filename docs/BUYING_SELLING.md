# Unity — Buying & Selling Architecture

> **Note:** this document predates the real order/checkout implementation (Step 7) and the
> admin/email layer built on top of it (Step 11 Phase 6). For the current order lifecycle, admin
> monitoring, exception queue, and transactional emails, see `docs/ORDER_ADMINISTRATION.md`.

## Status: Phase 2A live (browse + listing creation) — purchasing not yet built

The schema (`supabase/migrations/20260720000003_buying_selling_schema.sql`,
extended by `20260809000001_listing_type_both.sql` and
`20260809000002_listing_type_both_usage.sql` to add a `'both'` type) is live,
and so is the merchant-facing half of Phase 2: a merchant can choose
Sell/Rent/Both when creating a listing, the wizard branches its pricing step
accordingly, and the public browse page's Buy/Rent toggle (`?mode=buy|rent`,
the Marketplace Mode Selector on `/listings`) filters real listings by
`listing_type`. The buyer-facing half — an actual purchase/checkout flow that
creates `orders` rows — is **not** built yet; a sale listing's detail page
shows its real price with a "Buying is coming soon" notice instead
(`src/components/listings/sale-summary-card.tsx`). See "What Phase 2 needs to
build" below for what's left.

## Why buying/selling matters now

The MVP brief makes buying & selling core scope, on equal footing with
rentals. The previous docs (`FEATURES.md`) had it listed under POST-MVP, and
the schema had no representation for a one-time sale at all — only
`daily_rate`/`weekly_rate` rental pricing. This is the largest scope gap
identified in the initial audit.

## Design decision: extend `listings`, add a separate `orders` table

Two shapes needed to coexist: rentals (date range, return step, escrow
releases on return) and sales (no dates, no return, escrow releases on
delivery confirmation). Three options were considered:

1. **One `listings` table, one `bookings`/`transactions` table for both
   types** — most "unified," but forces rental-only and sale-only columns to
   coexist as nullable fields on every transaction row, and would have
   required renaming/restructuring the already-built `bookings` table and
   its `Booking` TypeScript type that the rental UI already depends on.
2. **Fully separate stack** — `sale_listings`, `orders`,
   `order_disputes`, `order_reviews`, `order_messages` — lowest risk to
   existing rental code, but duplicates trust & safety infrastructure
   (disputes, reviews, messages) across two parallel systems that need to
   stay behaviorally identical. Given trust & safety is priority #1, this
   duplication is a maintenance liability.
3. **Chosen: extend `listings` with a `listing_type` discriminator (rentals
   and sales share title/description/category/condition/media/ownership
   proof/affiliate settings — genuinely the same entity), add a new `orders`
   table parallel to `bookings` (the transaction shapes are different enough
   to not force together), and make `reviews`/`disputes`/`messages`/
   `affiliate_referrals` dual-purpose** via a nullable `booking_id` +
   nullable `order_id` pair with a `CHECK` constraint enforcing exactly one
   is set.

Option 3 was chosen because it reuses trust & safety infrastructure (option
2's main weakness) without disturbing the existing rental `bookings`
table/type (option 1's main weakness), and the `CHECK (exactly one set)`
pattern keeps real foreign-key integrity — evidence-linked disputes still
reference a real, single transaction row, not a loosely-typed polymorphic
association.

This was a safe schema change to make now, before real data exists: the
audit confirmed no booking, dispute, review, or message is currently
persisted anywhere in the running app (see prior audit, §4/§10), so there
was nothing to migrate.

## Schema summary

**`listings`** gains:
- `listing_type` enum (`'rental' | 'sale' | 'both'`), default `'rental'` — the
  third value, `'both'`, was added in `20260809000001_listing_type_both.sql`
  once Phase 2A needed it; see "One listing, both prices" below for why it's
  a single row rather than two linked listings
- `sale_price numeric(10,2)`, nullable
- `quantity_available int`, default 1
- `daily_rate` becomes nullable (previously `NOT NULL`)
- `CHECK` constraint (`listings_type_pricing_chk`): `rental` rows must have
  `daily_rate` set and `sale_price` null; `sale` rows must have `sale_price`
  set and `daily_rate` null; `both` rows must have **both** set

Everything else on `listings` — title, description, category, condition,
`listing_media`, ownership proof, `min_unity_score`, `risk_tier`,
`accepts_affiliates`/`affiliate_commission_rate`, `status` — applies to both
types unchanged. Ownership proof requirements apply to sale listings too
(preventing stolen-goods listings matters at least as much for a sale as a
rental).

**`orders`** (new table, parallel to `bookings`):
- `listing_id`, `buyer_id`, `seller_id` (named `seller_id` rather than
  reusing `merchant_id` — a private seller of a personal item and a
  rental "merchant" are conceptually the same `profiles` row/role today,
  but the column name should describe the transaction, not assume a
  merchant relationship)
- `quantity`, `unit_price`, `shipping_fee`, `total_amount`
- `status` enum: `pending → paid → shipped → delivered`, or `disputed` /
  `cancelled`
- `payfast_payment_id`, `affiliate_id`, `affiliate_commission_amount` —
  same shape as `bookings` for consistency with the (also not-yet-built)
  payment and affiliate wiring
- RLS: buyer/seller can read their own orders; buyer can insert; either
  party can update — mirrors the existing `bookings` policies exactly

**`reviews` / `disputes` / `messages`** gain a nullable `order_id` column
alongside the now-nullable `booking_id`, with a `CHECK` enforcing exactly
one is set. RLS policies are extended (not replaced) to also match via the
`orders` party check.

**`affiliate_referrals`** gains a nullable `order_id`, so the existing
merchant affiliate program (toggle + commission rate) works identically for
sale listings — the MVP brief calls out "affiliate promotion of individual
listings" without distinguishing rental vs. sale.

## "Both" — one listing, both prices

When Phase 2A needed a `listing_type = 'both'` option (list an item as
available to either rent or buy outright), two shapes were possible: one
listing row carrying both `daily_rate` and `sale_price`, or two separate
linked listings (one rental, one sale) sharing a common item reference.
**Chosen: one row, both prices** — specifically because it lets a single
`quantity_available` govern both transaction paths, so a physical item can
never be double-committed to a rental and a sale at the same time. Two
linked listings would need their own cross-listing quantity-reservation
logic to get the same guarantee. The tradeoff: `save_listing_draft` must
clear the irrelevant price field via `CASE` (not `coalesce`) whenever a
merchant switches a draft's type, so a listing can never end up with a
stale price value that violates `listings_type_pricing_chk`.

## What Phase 2 needs to build

Done (this pass):
- ✅ `Order` TypeScript type, `ListingType`/`sale_price` on the `Listing`
  type (`src/types/index.ts`)
- ✅ Listing creation wizard branches on Sell/Rent/Both — a new "Type" step
  (`TypeStep` in `create-listing-flow.tsx`) picks `listing_type`, the
  pricing step conditionally shows Sale price vs. Daily/Weekly rate (or
  both), and the deposit/renter-requirements step is skipped entirely for
  pure `sale` listings
- ✅ `save_listing_draft` persists `listing_type`/`sale_price`, clearing the
  now-irrelevant price field on a type switch (CASE-based, not coalesce —
  see the migration's own comment for why coalesce would violate the CHECK
  constraint)
- ✅ `computeListingCompleteness` branches required fields on
  `rentable`/`sellable` derived from `listing_type`
- ✅ Browse page (`/listings`) Buy/Rent/Barter toggle filters real listings
  by `listing_type` via `?mode=` — Barter has no backing data model, so it
  shows a "coming soon" state rather than querying listings
- ✅ Listing detail page renders `SaleSummaryCard` (price, quantity,
  "Buying is coming soon") alongside or instead of `BookingCard`

Not done yet:
- A purchase checkout flow (parallel to `booking-flow.tsx`) that actually
  creates `orders` rows — no date picker, no return step; escrow releases on
  delivery confirmation instead of return confirmation
- API routes / server actions for creating orders, transitioning order
  status, and the same PayFast integration gap noted for bookings (no
  ITN webhook exists yet for either flow)
- Risk Engine trigger update to branch on `listing_type` and use
  `sale_price` (flagged in `RISK_ENGINE.md`'s "Known limitation")
- Renter/merchant dashboards need an "orders" view alongside "bookings"
- Admin panel needs order visibility alongside booking visibility

## Open question for Phase 2

Should a `profiles.role` of `'renter'` be allowed to sell (list a `sale`
listing) without also being a `'merchant'`? The MVP brief doesn't
distinguish "casual seller" from "merchant" the way many marketplaces do.
Current recommendation: treat `listing_type = 'sale'` as available to any
authenticated user regardless of `role`, same KYC gate as merchant listing
(required before first listing), and revisit if usage data suggests a
need to separate "casual seller" from "merchant" UX. Flagging this now so
it isn't decided implicitly by whatever the Phase 2 implementation happens
to default to.
