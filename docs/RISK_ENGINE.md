# Unity — Risk Engine

## Why this exists

Unity's MVP explicitly excludes credit scoring, credit building, credit
bureau reporting, and NCR registration. The previous schema/UI had a
`requires_credit_score` / `min_credit_score` pair on `listings`, merchant-set
at listing creation, gating bookings behind a (simulated) KYC check. That's
gone. The Risk Engine replaces it with something structurally different: a
**system-assigned** LOW / MEDIUM / HIGH classification per listing that
drives trust-and-safety requirements (verification, deposit, insurance,
manual review) — not a creditworthiness judgment about the renter.

## Core design decision: users cannot override it

This is a hard requirement, not just a UI convention. The implementation
enforces it at the database layer, not just the application layer:

- `listings.risk_tier` is set by a **Postgres `BEFORE INSERT OR UPDATE`
  trigger** (`compute_listing_risk_tier()`,
  `supabase/migrations/20260720000002_risk_engine.sql`).
- The trigger **overwrites `NEW.risk_tier` unconditionally** on every write,
  regardless of what value a client (merchant wizard, API route, direct
  Supabase call) sends for that column. There is no code path — client,
  server, or direct DB write through the anon/authenticated role — that can
  set an arbitrary tier.
- The only way to change a listing's tier is to change the signals that
  drive it (price, category, or the merchant's KYC/Unity Score standing),
  which then get recomputed automatically on the next write.

This is a stronger guarantee than an application-layer check (e.g.
"reject if the request body includes `risk_tier`"), because it holds even if
a future code path forgets to strip the field, and even against direct
database access.

A TypeScript mirror (`src/lib/risk/engine.ts`) implements the same rules for
client-side preview only — e.g. showing a merchant what tier their listing
will land in while they're still filling out the wizard, before it's ever
written to the DB. **The trigger is the source of truth; the TS module is a
preview.** The two must be kept in sync manually — see "Known limitation"
below.

## How the tier is determined

Two inputs combine, then one modifier applies:

**1. Category floor** — some categories carry risk regardless of price:

| Category | Floor |
|---|---|
| Vehicles | High |
| Tech, Tools, Fashion, Music | Medium |
| Outdoor, Events, Sports, Baby | Low |

**2. Value-based tier** — from the listing's price:

| Rental (daily rate, ZAR/day) | Sale (price, ZAR) | Tier |
|---|---|---|
| < 500 | < 3,000 | Low |
| 500 – 2,499 | 3,000 – 14,999 | Medium |
| ≥ 2,500 | ≥ 15,000 | High |

Rental and sale thresholds are deliberately different scales — a R2,500/day
rental and a R2,500 one-time sale represent very different exposure.

**Base tier = max(category floor, value tier).**

**3. Trust modifier** — if the merchant's `kyc_status !== 'approved'` OR
`unity_score < 3.0`, the base tier is raised by one level (capped at High).
An unverified or low-standing merchant increases platform risk independent
of the item itself.

These thresholds are a deliberate, explainable MVP starting point (not a
model) so that any tier assignment can be justified to a merchant who asks
why their listing was flagged. They should be revisited with real
loss/dispute data post-launch.

## Consequences per tier

| Requirement | Low | Medium | High |
|---|---|---|---|
| Ownership verification | Not required | **Required** | **Required** |
| Inspection video | Not required | **Required** | **Required** |
| Deposit | Optional | Recommended | **Mandatory** |
| Insurance | Not required | Not required | **Mandatory** |
| Manual review before going live | No | No | **Yes** |

`src/lib/risk/engine.ts`'s `getRiskRequirements(tier)` returns this as a
typed object so UI surfaces (listing wizard, listing detail page, booking
flow) render consistently from one source instead of re-deriving the rules.

## What Phase 1 delivers vs. Phase 2

Phase 1 (this change) delivers:
- The DB trigger + `risk_tier` column (functional, authoritative).
- The TS module (functional, used for preview in the listing wizard, and to
  display requirements on the listing detail page and booking review step).
- Removal of the credit-score gate it replaces.

Not yet built (Phase 2 — feature work, not architecture):
- **Enforcement** that a listing can't transition `draft`/`pending` →
  `active` unless its tier's requirements are actually met (e.g. a HIGH risk
  listing shouldn't be publishable without `ownership_verified = true`,
  `deposit_required = true`, and `insurance_amount > 0`). Today the wizard
  *displays* the requirements but the publish flow itself isn't wired to
  persist listings at all yet (a pre-existing gap noted in the audit) — this
  needs to land together with real listing persistence.
- An admin queue for the "manual review" step on HIGH risk listings.
- Recording *why* a listing got its tier (the specific inputs) for
  merchant-facing transparency and dispute purposes.

## Known limitation

The SQL trigger and the TypeScript module are two independent
implementations of the same rules, because they run in different languages
at different layers (DB vs. client preview). They must be kept in sync by
hand. If they drift, the trigger (DB) always wins since it's authoritative —
but a drifted TS preview would show a merchant an incorrect tier prediction
during listing creation. Recommend a unit test that asserts the two produce
identical output across a matrix of representative inputs.

Additionally, the current trigger only reads `NEW.daily_rate` for the
value-based tier. Once the Buying & Selling schema
(`BUYING_SELLING.md`) is used by real sale listings, the trigger needs to
branch on `NEW.listing_type` and use `NEW.sale_price` for sale listings,
mirroring what `src/lib/risk/engine.ts` already does. This is flagged here
so it isn't forgotten — no sale listings exist yet since no Phase 2 app code
creates them, so the gap is latent, not currently exploitable.
