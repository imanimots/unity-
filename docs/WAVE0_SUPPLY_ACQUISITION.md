# Wave 0 Supply Acquisition Plan

Executable merchant-recruitment and listing-onboarding plan to close the supply gap identified by `scripts/wave0-supply-readiness.mjs`. See `docs/WAVE0_OPERATIONS.md` for the Wave 0 cohort/category/KYC/ownership/support/dispute/logistics rules this plan operates under — not repeated here.

**Data caveat, carried forward from this phase's own verification**: the numbers below were produced by actually running `scripts/wave0-supply-readiness.mjs` against the one Supabase project this environment can reach. That project's ref is identical to `QA_SEED_PROJECT_REF` — it is this repository's QA/seed project, not an independently confirmed production database. Treat every count below as "what the QA/seed environment currently shows," and re-run the script against genuine production credentials before trusting these numbers as real marketplace state.

## A. Objective

Move observed supply from:
- **2 active non-test merchants / 6 active non-test listings**

to at least:
- **12 merchants / 25 launch-quality listings** (minimum)
- 20+ merchants / 40+ listings (preferred)

Current category coverage for all five Wave 0 categories (outdoor, events, sports, baby, tools) is **zero** — none of the 6 existing active non-test listings fall into any Wave 0 category. Every category needs supply built from nothing, not just topped up.

## B. Merchant Recruitment Target

- Minimum: 10 additional approved merchants (2 existing + 10 = 12)
- Preferred: 18+ additional merchants (2 existing + 18 = 20)

## C. Listing Target

- Minimum: 19 additional launch-quality listings (6 existing + 19 = 25) — but since none of the 6 existing listings are in a Wave 0 category or launch-ready (see Existing Supply Remediation below), the realistic operational target is **25+ new/remediated listings**, not a top-up of 19.
- At least 3 listings in each of outdoor/events/sports/baby/tools (15 minimum across categories, within the 25 total).

## Merchant Types to Target

| Category | Likely profiles |
|---|---|
| Outdoor | Camping equipment owners, outdoor equipment shops, hiking/camping suppliers, private owners with tents/gazebos/camping gear |
| Events | Event equipment owners, party equipment suppliers, chairs/tables/gazebo rental operators, sound/light equipment owners, small event businesses |
| Sports | Private sports equipment owners, sports clubs, sports equipment stores, fitness equipment owners |
| Baby | Verified private owners, baby equipment rental businesses, parents with high-quality unused equipment |
| Tools | Tool hire businesses, contractors, tradespeople, private tool owners, small hardware/tool businesses |

Not exhaustive — any supplier whose inventory fits the current marketplace category taxonomy is a valid prospect.

## Merchant Recruitment Priority

| Tier | Profile | Why prioritized |
|---|---|---|
| A | Existing rental/hire businesses with real inventory | Fastest path to supply density — one onboarding, many listings |
| B | Small businesses owning under-utilized equipment | Real inventory, lower onboarding friction than individuals |
| C | Verified individuals with several suitable items | Slower per-merchant yield but still multi-listing |
| D | Single-item private owners | Lowest yield per onboarding — useful for category gaps, not for hitting density targets quickly |

Prefer Tier A/B first — Wave 0 needs supply density fast, and a merchant who can list 5 items in one onboarding is worth more right now than 5 merchants who can each list 1.

## Existing Supply Remediation

The 6 existing active non-test listings are a **remediation queue**, not supply to delete. Confirmed problems (from the live script run):

| Issue | What's needed to count toward Wave 0 |
|---|---|
| Category mismatch (none fall into outdoor/events/sports/baby/tools) | Merchant or admin must confirm the item's correct category, or the listing simply doesn't count toward Wave 0 category targets even if otherwise fixed |
| 0% have ≥3 photos | Merchant must upload at least 3 real, current, non-stock photos per listing |
| 0% have province/city/collection_area set | Merchant must complete these three location fields |
| 2 of 6 require ownership verification (risk_tier medium/high) and 0% are verified | Merchant must submit ownership evidence; admin must review and approve via the existing `/admin/listings/[id]` ownership workflow |

None of these require any code change — every field already exists and is editable through the existing listing wizard/edit flow.

## Merchant Onboarding Flow

| Step | Platform-enforced or manual ops control |
|---|---|
| 1. Merchant invited | Manual (ops outreach) |
| 2. Account created | Platform-enforced (signup flow) |
| 3. KYC initiated | Platform-enforced (optional-at-signup, prompted) |
| 4. KYC approved | Platform-enforced (admin review RPC), manual review by ops |
| 5. Merchant briefed on pilot | Manual (ops) |
| 6. Categories/items identified | Manual (ops + merchant conversation) |
| 7. Listings created | Platform-enforced (listing wizard), merchant-driven |
| 8. Photos added | Platform-enforced minimum (3), merchant-driven quality |
| 9. Location completed | Platform-enforced fields, merchant-driven accuracy |
| 10. Ownership evidence submitted where required | Platform-enforced gate (risk-tier driven), merchant-driven |
| 11. Ownership reviewed | Manual (admin review queue, `/admin/listings/[id]`) |
| 12. Listing quality reviewed | Manual (ops spot-check against the Listing Quality Standard below) |
| 13. Listing activated/confirmed active | Platform-enforced (status transition), triggered by merchant publish + passing checks |
| 14. Merchant signs off availability | Manual (ops confirms with merchant before counting it as pilot supply) |
| 15. Listing added to Wave 0 supply count | Manual (ops updates `docs/WAVE0_LISTING_READINESS_TRACKER.csv`) |

## Listing Quality Standard

A Wave 0 listing is launch-ready only if **all** of the following hold:
- Real item, non-test (`is_test = false`)
- `status = 'active'`
- Valid Wave 0 category (outdoor/events/sports/baby/tools)
- Meaningful title and description (not placeholder text)
- Condition disclosure completed
- Minimum 3 genuine, current, non-stock photos
- `province`, `city`, and `collection_area` all populated
- Self-collection is possible for this listing
- Ownership verification complete where `risk_tier` is medium/high
- No unresolved ownership concern
- Not in an excluded Wave 0 category (vehicles, tech, fashion, music)

Do not count a listing toward launch supply unless every item above is true — partial completion does not count as "pilot eligible" (see the Listing Readiness Tracker).

## Merchant Communication Scripts

**A. First contact**: "Hi [name] — we're Unity, a new peer-to-peer rental marketplace launching a small, invite-only pilot in South Africa. We think [their business/items] would be a great fit for early supply. Would you be open to a quick chat about listing a few items?"

**B. Interested merchant follow-up**: "Thanks for your interest! Here's what the pilot involves: it's invite-only, no real money changes hands yet (test phase), and we'll walk you through listing your first items. Can we set up 15 minutes this week?"

**C. Onboarding instructions**: "To get your items listed: 1) create your account and complete the quick ID check, 2) tell us which items you'd like to list, 3) we'll help you take photos and fill in location details, 4) if the item needs ownership proof (receipt, invoice, etc.), upload that too, 5) our team reviews and activates your listing."

**D. Listing quality correction**: "Your listing for [item] is almost ready — we just need [specific missing item: more photos / location details / ownership proof] before it can go live in the pilot. Can you add that when you get a chance?"

**E. Ownership evidence request**: "Because of [item]'s value/category, we need a quick proof of ownership — a receipt, invoice, warranty, or similar document works. This stays private and is only used for our review."

**F. Ready-for-pilot confirmation**: "Your listing for [item] is now live in the Unity pilot. Since this is a no-real-money pilot, there's no payment involved yet — we'll be in touch if someone's interested in renting it."

Tone: professional, trustworthy, early-access framing — not hype-heavy. Never imply guaranteed income, insurance coverage, guaranteed renters, or guaranteed transactions.

## Listing Photo Checklist (for merchants)

Minimum 3 photos:
1. Front/main item photo
2. Alternate angle
3. Condition/detail photo

For tools/equipment, also recommended: serial/model plate where appropriate, existing damage/wear, included accessories.

All photos must be of the real item, clear, current — never stock images.

## Location Standard

Every Wave 0 listing needs `province`, `city`, and `collection_area` populated. This is not a request for a private home street address — `collection_area` should be specific enough (e.g. a suburb or well-known area) for a prospective renter to judge practical proximity before booking, without exposing an exact address.

## Ownership Verification Checklist (for operators)

Acceptable evidence types are limited to what the current implementation already supports (`ownership_proof_type` enum): receipt, invoice, warranty, registration, affidavit, asset_register, finance_agreement, other. Do not invent or accept any other verification mechanism.

Operator review steps:
1. Confirm the submitted evidence actually corresponds to the listed item (not a different item or a generic document).
2. Check for internal consistency (serial number, description, date) against the listing.
3. If ambiguous, escalate for a second opinion rather than approving under time pressure (per `docs/WAVE0_OPERATIONS.md`'s KYC/ownership operating limits).
4. Approve or reject via the existing `/admin/listings/[id]` ownership actions, always with a reason.

## Recruitment Cadence (14-day supply build — operational recommendation, not a technical requirement)

| Days | Focus |
|---|---|
| 1–2 | Build prospect list (Tier A/B first) |
| 2–5 | First outreach |
| 3–7 | Merchant onboarding (account + KYC) |
| 4–10 | Listing creation + corrections |
| 5–12 | KYC + ownership review |
| 10–13 | Supply quality cleanup (remediate existing + new listings against the Listing Quality Standard) |
| 14 | Wave 0 supply gate — re-run `scripts/wave0-supply-readiness.mjs` and compare to the minimum target |

## Daily Targets (arithmetic from the current deficit, not inflated)

To close a 10-merchant deficit in roughly the first 7 days of outreach (days 2–7 above): **~1.5 merchants onboarded per day**, which in practice means contacting more prospects than that daily, since not every contact converts — plan to contact 3–5 prospects per day to onboard ~1–2.

To close a 19-listing deficit by day 10: **~2 listings created per day** from day 4 onward, with quality corrections continuing through day 13.

These are planning targets for the ops team, not promises to merchants, and not enforced anywhere in code.

## Sequencing: Supply Before Demand

Per the brief's own instruction and this plan's logic: **do not begin broad user/renter acquisition until supply is close to the minimum threshold.** User cohort assembly (the 15–25 users in `docs/WAVE0_OPERATIONS.md`) should start once merchant/listing supply is approaching — not yet at — the minimum gate, so early users have something real to browse without an empty-marketplace experience.
