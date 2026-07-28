# Unity — Buying & Selling Architecture

## Status: database design only

This document and the accompanying migration
(`supabase/migrations/20260720000003_buying_selling_schema.sql`) define the
schema. **No application code — API routes, UI, or TypeScript types — has
been built against it yet.** That's Phase 2, once this design is approved.

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
- `listing_type` enum (`'rental' | 'sale'`), default `'rental'`
- `sale_price numeric(10,2)`, nullable
- `quantity_available int`, default 1
- `daily_rate` becomes nullable (previously `NOT NULL`)
- `CHECK` constraint: rental rows must have `daily_rate` set and `sale_price`
  null; sale rows must have `sale_price` set and `daily_rate` null

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

## What Phase 2 needs to build (not done yet)

- `Order` TypeScript type, `ListingType`/`sale_price`/`quantity_available` on
  the `Listing` type
- A sale variant of the listing creation wizard (or branching the existing
  one on `listing_type`) — pricing step becomes "sale price" instead of
  daily/weekly rate; no min-rental-days/shipping-payer-for-return concepts
  apply the same way
- A purchase checkout flow (parallel to `booking-flow.tsx`) — no date
  picker, no return step; escrow releases on delivery confirmation instead
  of return confirmation
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
