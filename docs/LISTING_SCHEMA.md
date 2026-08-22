# Unity — Listing Wizard Schema

## Status: schema approved, Phase 2A (persistence) in progress

The five migrations below (`20260729000002` through `20260729000006`) define the schema. **Phase 2A** (see "Phase 2A — field mapping & implementation notes" at the end of this document) wires the existing merchant listing wizard up to it for real: validation, storage uploads, and an atomic multi-table write via a new RPC. Booking, payments, KYC, and admin moderation UI remain out of scope — see the Phase 2A section for the exact boundary.

This mirrors how `docs/BUYING_SELLING.md` + `20260720000003_buying_selling_schema.sql` shipped: schema and rationale first, reviewed on its own, before any UI/API work lands on top.

## Why this exists

The MVP brief calls for a much richer listing wizard than what's built today — item detail, condition disclosure, photo requirements, ownership verification, granular pricing, availability, renter requirements, usage/damage/cancellation terms, moderation, and an audit trail. Building all of that as new columns bolted onto `listings` would violate two things this schema deliberately protects: **public/private data separation** (every public listing read in `src/lib/data/listings.ts` does `select('*', ...)`, so anything sensitive placed on `listings` ships to the public listing page on day one) and **row-level security's column blindness** (RLS grants or denies a whole row — it cannot expose one column of a row while hiding another to the same caller, which matters a lot once "things only admins should see" and "things merchants should see" start living near each other).

## Table-by-table reference

### `listings` (extended)

All fields below are **public** (readable by anyone once the listing is `active`, via the existing `"listings: public read active"` policy) unless noted. Values in *italics* are pre-existing columns, listed for context only.

| Field | Type | Public? | Validation |
|---|---|---|---|
| *category (text), condition (enum)* | — | public | see "Category & condition strategy" below |
| `category_id`, `subcategory_id` | uuid FK, nullable | public | additive, unbackfilled this pass — see below |
| `brand`, `model`, `colour`, `size`, `specifications`, `included_accessories` | text | public | free text |
| `replacement_value` | numeric | public | `> 0` if set |
| `year_of_manufacture` | int | public | `1900–2100` if set |
| `tags` | text[] | public | free text array |
| `province`, `city`, `collection_area` | text | public | approximate area only — never an exact address (see Handover below) |
| `known_defects`, `wear_description`, `functional_status`, `missing_parts`, `repair_history` | text | **public, deliberately** | the spec's point is renters see disclosed defects, not that they're hidden |
| `condition_confirmed` | bool | public | merchant's "I confirm the condition/defects described are accurate" flag |
| `weekend_rate`, `monthly_rate` | numeric | public | `> 0` if set |
| `max_rental_days` | int | public | `>= min_rental_days` if set |
| `available_from` | date | public | — |
| `min_booking_notice_days`, `max_advance_booking_days` | int | public | `>= 0` if set |
| `recurring_unavailable_weekdays` | int[] | public | `0`=Sun..`6`=Sat |
| `pickup_available`, `delivery_available`, `merchant_delivery_available`, `courier_allowed`, `renter_collection_allowed` | bool | public | — |
| `preferred_handover_times` | text | public | a time window ("weekday evenings"), not an address |
| `ownership_proof_type` | enum | public | low-sensitivity category label; the document itself lives in `listing_media`/private storage |
| `ownership_declaration_accepted` | bool | public | cheap summary flag only — the legal record is `listing_declarations` |
| `promotional_terms`, `campaign_start_date`, `campaign_end_date` | text/date | public | extends existing `accepts_affiliates`/`affiliate_commission_rate`; no new affiliate infrastructure |
| `category_metadata` | jsonb | public | **non-sensitive** category display attributes only — see promotion rule below |

### `listing_private_details` (new — merchant + service_role read only, no public policy)

| Field | Type | Validation |
|---|---|---|
| `listing_id` | uuid PK/FK | — |
| `purchase_date` | date | — |
| `purchase_price` | numeric | `> 0` if set |
| `retailer_or_seller` | text | — |
| `serial_number` | text | merges wizard spec sections A ("serial number") and D ("serial number, IMEI, VIN... where relevant") into one field — not duplicated |
| `handover_instructions` | text | merchant-only until a real booking-confirmation flow exists to reveal it to a *confirmed* renter |
| `private_category_metadata` | jsonb | **sensitive** category-specific identifiers only: VIN, registration number, IMEI, device serial numbers, ownership-document references |

**Why private:** every one of these either identifies a real person (retailer, purchase price implies financial info) or a specific physical item in a way that enables tracking/theft/fraud (serial number, VIN, IMEI) or is address-adjacent (handover instructions). None of it belongs on a row that's readable via a plain public `select('*')`.

### `listing_availability` (new — one-to-many, public read)

`id`, `listing_id`, `start_date`, `end_date` (`CHECK end_date >= start_date`), `reason`, `created_at`. Public read (renters need this to judge bookability before requesting), merchant-only insert/delete. Indexed on `(listing_id, start_date, end_date)`.

### `listing_requirements` (new — 1:1, public read)

Public for the same reason as availability: renters must see requirements and usage/damage/cancellation terms *before* they book, not after. Full field list is in the migration (`20260729000002_listing_wizard_fields.sql`); grouped as renter requirements, usage rules, damage/liability, cancellation, and deposit basis. Two explicit bans carried over from the wizard spec: **no new insurance products** (no coverage amounts/types invented beyond the existing `insurance_amount` field on `listings`) and **no refund-percentage/cancellation-penalty fields at all** — if that policy remains unresolved, nothing financial is stored for it.

`final_deposit_amount` is system-calculated and privileged (see Security hardening) — `requested_deposit_amount` is the merchant's ask, `final_deposit_amount` is what the (not-yet-built) risk-tier deposit logic actually approves. `mileage_limit` here is a *renter usage cap* ("you may not exceed 200km"), explicitly distinct from a vehicle's own current odometer reading, which belongs in `listing_private_details.private_category_metadata` — don't merge the two.

### `listing_declarations` (new — append-only, immutable)

The versioned legal record of what a merchant accepted at submission time: `declaration_type` (`ownership_authority`/`condition_accuracy`/`image_accuracy`/`legal_and_safe_item`/`platform_terms`/`off_platform_transaction_policy`), `declaration_version`, `declaration_text_hash` (proves the exact wording accepted, even if copy changes later), `accepted`, `accepted_at`, `ip_address`/`user_agent` (optional, private — the whole table is merchant+admin-only, no public policy). One row per declaration acceptance, not one row per listing — a listing accumulates one row per `declaration_type` it was ever asked to accept.

**Immutability**: enforced by a hard `BEFORE UPDATE OR DELETE` trigger (`prevent_row_mutation()`) that raises unconditionally, for every role including `service_role` — there's never a legitimate reason to alter an accepted declaration after the fact. This is a stronger guarantee than an RLS gap (no UPDATE/DELETE policy) alone, which only stops `anon`/`authenticated` — a future service-role bug (e.g. an accidental bulk update) would still be blocked by the trigger.

**Write path**: `merchant_id` is meant to come from the authenticated session on the server, never from client input — but there's no write path yet to enforce that against (that's the future listing-mutation service), so this is documented intent, not a SQL-level guarantee today.

### `listing_history` (new — append-only, immutable audit log)

`listing_id`, `changed_by` (nullable — null for system-initiated changes), `old_values`/`new_values` (jsonb), `change_reason`, `created_at`. Same immutability trigger as `listing_declarations` (shared `prevent_row_mutation()` function, not duplicated).

**Why a service writes this, not a trigger**: a blanket "log every UPDATE" trigger on `listings` would capture every column touch with zero business context — "what changed" without "why," which is worse than no log at all for dispute resolution ("the merchant says the price was always R500, we say it changed — when, and did they explain why?"). The intended design is a future server-side listing-mutation service that writes an explicit, reasoned `listing_history` row alongside whatever change it makes, using the `service_role` client (which bypasses RLS for the insert — no client-facing INSERT policy exists on this table). **Not built this pass.**

**Read access**: merchant reads history for their own listings; admin reads all, via a new RLS pattern — `exists (select 1 from profiles where id = auth.uid() and role = 'admin')` — introduced here since every admin data path in the app has been mock-only until now, so there was no prior real "admin RLS policy" precedent to follow. `listing_moderation`'s admin policies reuse this exact pattern.

### `listing_moderation` (new — admin/service_role write, merchant read via view) + `moderation_status` enum

Kept entirely separate from `listings.status` — see "Status vs. moderation" below. Base table: `listing_id`, `moderation_status` (`pending`/`approved`/`rejected`/`requires_review`/`flagged`), `moderation_notes` (**internal, admin-only**), `moderated_by`, `moderated_at`, `rejection_reason` (**merchant-safe**), timestamps.

**Why a view, not a table-level policy**: RLS is row-level, not column-level — one policy can't let a merchant see `rejection_reason` on their own row while hiding `moderation_notes` on that same row. `listing_moderation_merchant_view` selects only `listing_id`/`moderation_status`/`rejection_reason`/`moderated_at` — `moderation_notes` is simply never in its column list, so it can't leak via a careless `select('*')` against the view the way it could against the base table. The view is defined with `security_invoker = false` (explicit, not relying on a Postgres default) and its own `join listings ... where listings.merchant_id = auth.uid()` filter baked into the query — it runs with the privileges of its (privileged) owner, bypassing the base table's admin-only RLS, and the view's own WHERE clause is what actually restricts a merchant to their own rows. `grant select ... to authenticated` makes it queryable.

**Write path**: no client INSERT policy — the future listing-mutation service creates the initial `pending` row (service_role) when a listing is submitted for review. Admin updates go through the base table via the `profiles.role = 'admin'` RLS check (same session-based pattern the app already uses for real admin actions, not a switch to service_role).

## Status vs. moderation

`listings.status` (lifecycle: `draft`/`pending`/`active`/`paused`/`rented`/`suspended`) and `moderation_status` (review verdict: `pending`/`approved`/`rejected`/`requires_review`/`flagged`) are deliberately separate enums in separate tables. Conflating them would mean "is this listing visible to renters" and "has Unity reviewed it" fight over the same field. `activate_listing()` (service-role only) is the completeness + moderation-check gate now referenced below — built and live, not merely planned.

`paused` (merchant-controlled temporary withdrawal) and `suspended` (admin/moderation-controlled) are distinct states with distinct authority — a merchant can never self-resume a `suspended` listing; only `activate_listing()` (admin-invoked) can move a listing out of `suspended`.

**Individual pause/resume is a basic listing lifecycle control available to every merchant subscription tier (Starter/Pro/Elite alike) — it is not a paid entitlement.** `POST /api/listings/[id]/pause` and `.../resume` call `merchant_pause_listing()`/`merchant_resume_listing()` directly, with no `bulkListingEnabled`-style gate. **Bulk listing management (pausing/resuming many listings at once) remains Pro/Elite-only** — `POST /api/listings/bulk` (gated on `entitlements.bulkListingEnabled`) loops the identical per-row RPCs, so the two paths share the exact same ownership/state/cap authority and differ only in whether the *bulk* capability is entitled.

| Transition | Who |
|---|---|
| anything → `draft` | merchant (edit/save draft) |
| `draft` → `pending` | merchant (submit for review) |
| `active` → `paused` | merchant (self-service, individual or bulk, any tier for individual — see above) |
| `paused` → `active` | merchant (self-service resume — `merchant_resume_listing()`, revalidates publication cap + downgrade-freeze state on every call, any tier for individual) |
| `active` → `suspended` | admin only (`suspend_listing()`, moderation action) |
| `suspended` → `active` | admin only (`activate_listing()`) — merchants cannot self-resume a suspension |
| `pending`/`suspended` → `active` | admin (`activate_listing()`, re-checks moderation + publication cap) |
| any status → `rented` | **blocked from direct client writes** — requires a real booking transition, which doesn't exist yet |
| any status, if starting from `draft`/`pending`/`paused`/`rented` and NOT changing to `active`/`rented` | merchant, freely (e.g. editing other fields while paused) |

`featured`, `suspended`, `admin-approved`, and `fraud-cleared` are not columns anywhere in this schema. The wizard spec's instruction that the browser must never set them is a security *principle*, not a literal field inventory — if any of these is added later, it must join the same privileged-fields trigger, not ship as a plain client-writable column.

## Category & condition strategy

**Category is normalized** (`categories`/`subcategories` tables) because it was the genuinely weak case: `listings.category` is `text not null` with zero database-level constraint, validated only client-side against the `CATEGORIES` const in `src/types/index.ts`. `categories`/`subcategories` are seeded with the 9 existing MVP categories (tech/outdoor/tools/fashion/events/vehicles/music/sports/baby), using the existing category ids as `slug` for continuity. No subcategories are seeded — none exist in current app data anywhere; the table is structurally ready without another schema change once some are defined.

`listings.category_id`/`subcategory_id` are **new, nullable, additive** columns — the existing `category text not null` column is untouched and remains the only field any current app code reads or writes. A future migration backfills `category_id` from the text column once the data-layer is updated to use it; only after that would a further migration consider dropping the legacy column. Nothing here is dropped or renamed this pass.

**Condition is deliberately left unchanged.** `item_condition` is already a real Postgres enum (`new`/`like_new`/`good`/`fair`, from the initial schema migration) — not raw text, not a weak enum. It's adequate for the 4 MVP condition values. No `listing_conditions` table is created. This is a considered decision, not an oversight: introducing a table where an adequate enum already exists would be exactly the "duplicate category/condition system" this pass was asked to avoid.

## `category_metadata` / `private_category_metadata` promotion rule

A category-specific field starts in jsonb (public `listings.category_metadata` if non-sensitive, private `listing_private_details.private_category_metadata` if it's an identifier). **It gets promoted to a typed column or normalized reference the moment it's needed for**: search, filtering, sorting, ranking, cross-category validation, reporting, pricing, risk scoring, availability, or compliance. Not before — building typed columns for every category's every attribute up front, for a 9-category MVP where the risk engine (`compute_listing_risk_tier()` / `src/lib/risk/engine.ts`) keys only on `category` + price + merchant trust and never a category-specific attribute, would be speculative schema with no consuming logic.

Worked examples:
- A vehicle's **transmission type**, once something lets renters filter by it → promote to a typed column.
- A device's **battery health**, shown only for display on the listing page → may stay in `category_metadata` indefinitely.
- A device's **IMEI**, used for ownership/ID verification → belongs in `private_category_metadata` (sensitive identifier), typed if a verification workflow starts querying it directly.
- A vehicle's **odometer reading** (the item's own attribute) → `private_category_metadata` if treated as sensitive, or `category_metadata` if not — either way, **not** the same field as `listing_requirements.mileage_limit` (a renter usage cap). The two use the word "mileage" for different concepts; don't merge them.

"Property" is out of scope for category-specific fields entirely — it isn't one of the 9 launch categories (`CLAUDE.md` explicitly marks Property as post-MVP).

## Ownership-proof privacy (table *and* storage)

Two separate systems needed fixing, and fixing one does not fix the other:

1. **Table**: `"listing_media: public read"` had no `type` filter, so `type = 'ownership_proof'` rows — pointing into the private `ownership-proofs` storage bucket — were publicly listable via the table (leaking path/existence/naming/timestamp metadata) even though the file bytes themselves were already protected by storage policy. Fixed: public read now excludes `ownership_proof` rows; a merchant-own-listing policy and a new admin policy cover it instead.
2. **Storage**: the existing `ownership-proofs` bucket policy only lets the *uploading merchant* read their own files (`auth.uid()::text = foldername[1]`) — there was no admin read path at the storage-object level either, so even after the table fix, an admin could see a row exists but not view the actual document. Fixed with a new `storage.objects` policy granting admin read on that bucket.

Both fixes live in `20260729000006_listing_security_hardening.sql`.

## Migration order & dependencies

```
20260729000002_listing_wizard_fields.sql          (listings columns, listing_private_details,
                                                     listing_availability, listing_requirements,
                                                     listing_media.shot_type)
        │
20260729000003_listing_declarations_and_history.sql (listing_declarations, listing_history —
        │                                              reference listings, profiles)
20260729000004_listing_moderation.sql               (listing_moderation — references listings;
        │                                              view references listing_moderation + listings)
20260729000005_listing_category_normalization.sql   (categories, subcategories; listings.category_id/
        │                                              subcategory_id — independent of 000003/000004)
20260729000006_listing_security_hardening.sql       (depends on listings, listing_requirements,
                                                       listing_media, profiles all existing — must run last)
```

000003, 000004, and 000005 don't depend on each other and could in principle be applied in any relative order to each other, but 000002 must run first (everyone references `listings` columns/tables it adds) and 000006 must run last (it adds triggers/policies to tables the earlier four create).

## Rollback considerations (reference only — not executed)

Each migration's changes are additive (`add column if not exists`, `create table if not exists`, `create policy`) and can be reversed with the mirror-image `alter table ... drop column`, `drop table`, `drop policy`, `drop trigger`, `drop function`, `drop type` statements, in **reverse** migration order (000006 first, back to 000002 last), since later migrations depend on earlier ones. No migration in this set drops or renames an existing column, so rolling back never risks losing pre-existing data — only the new schema surface disappears. Rolling back `20260729000005` after `category_id` has been backfilled by a *future* migration would lose that backfilled data (not a concern yet, since no backfill has happened).

## Known limitations

- ~~Schema only — no wizard persistence yet.~~ **Addressed in Phase 2A** — see the section below.
- **No admin moderation write path yet.** `listing_moderation` rows can only be created/updated by a service-role or admin-session caller, and no such write path exists in the app yet (`src/app/admin/listings/page.tsx` is still local-state mock only, per the Phase 1 audit).
- **No real publishing-completeness service yet.** The `protect_listing_privileged_fields` trigger blocks *unsafe* direct transitions to `active`/`rented`; it does not compute *eligibility* (photo counts, required disclosures, risk-tier requirements) — that's deliberately application code, not SQL, because it will keep changing.
- **No live Supabase migration test was performed.** No project is connected this session (per the earlier Phase 1 conversation) — see the Verification section of the implementation report for what was checked instead, and the live-test checklist for the first real application.
- **No booking flow, payment integration, or ownership-verification service exist yet.** Pre-existing gaps, unrelated to this pass.
- **No automatic `listing_history` writer yet.** By design — a future service call, not a trigger (see rationale above).
- **Analytics columns** (`view_count`/`save_count`/`share_count`/`booking_count`/`report_count`) **and monetization columns** (`boost_level`/`featured_until`) **are deliberately not added.** These are derived metrics / paid-feature schema with no consuming feature yet — building them now would be speculative. Documented here as future requirements only.
- **A real admin write path is required before `ownership_verified` can ever become `true` in production** — once this pass's trigger ships, nothing in the current codebase can set it (previously any merchant could set it themselves, which was the bug being fixed). This is the direct, expected consequence of closing that gap, but worth flagging clearly so it isn't a surprise the first time a HIGH-risk-tier listing needs to go live.

---

## Phase 2A — field mapping & implementation notes

### Scope decision: what's required for a valid submission

Per "preserve the existing wizard design... add the minimum usable controls required for MVP submission," this pass does **not** add UI for every new field the Phase 0 schema supports. The required-for-submission set is: everything the wizard already collected (title, category, condition, description, ≥3 photos, one ownership-proof file, `daily_rate`, `min_rental_days`, `shipping_payer`), plus what was actually added — a "condition is accurate" confirmation checkbox, a "known defects" textarea, a damage-photo acknowledgement checkbox (all on the Ownership/Photos steps), and six declaration checkboxes (Review step, one per `declaration_type`). Every other new table/column is either **derived** from an existing wizard field, **defaulted** at the database level, or **deferred** (row still created so it exists for a future editing pass, but left at its column defaults). Nothing deferred blocks submission or is invented data — it's simply not collected yet.

**Built but not wired up this pass**: `src/lib/listings/category-fields.ts` implements the full category-specific field registry and validation (task 8) — vehicles/tech/tools public + private field definitions, unit-tested — but no wizard UI section calls it, and neither `save_listing_draft()` nor the `/api/listings` route currently accept a `category_metadata`/`private_category_metadata` payload. The validation layer is ready; the wizard form section and RPC parameter are the remaining work to actually populate these columns. Flagged explicitly rather than silently omitted — see the completion report's "Known limitations."

### Field mapping

**`listings`** — existing wizard fields map to their existing columns unchanged (`title`, `category`, `condition`, `description`, `daily_rate`, `weekly_rate`, `min_rental_days`, `shipping_payer`, `insurance_amount`, `min_unity_score`, `deposit_required`/`deposit_amount`, `accepts_affiliates`/`affiliate_commission_rate`). New columns:

| New field | Source |
|---|---|
| `category_id` | **server-computed** — resolved from the wizard's existing `category` string via a `categories` lookup by `slug`; rejected if not found or `is_active = false` |
| `subcategory_id` | deferred — always `null` (no subcategory UI; none are seeded yet either) |
| `condition_confirmed` | **new minimal UI** — one checkbox added to the Ownership step |
| `known_defects` | **new minimal UI** — a textarea added to the Ownership step; drives the Photos step's damage-photo requirement |
| `ownership_proof_type` | defaulted to `'other'` (no proof-type selector added) |
| `ownership_declaration_accepted` | **derived** — `true` once the `ownership_authority` declaration (see below) is accepted, not a separate control |
| `risk_tier`, `ownership_verified`, `merchant_id`, `status` | **server-computed / never client-set** — see Security controls in the implementation report |
| everything else new (`brand`, `model`, `replacement_value`, `year_of_manufacture`, `colour`, `size`, `specifications`, `included_accessories`, `tags`, `province`, `city`, `collection_area`, `weekend_rate`, `monthly_rate`, `max_rental_days`, `available_from`, `min_booking_notice_days`, `max_advance_booking_days`, `recurring_unavailable_weekdays`, `pickup_available`, `delivery_available`, `merchant_delivery_available`, `courier_allowed`, `renter_collection_allowed`, `preferred_handover_times`, `wear_description`, `functional_status`, `missing_parts`, `repair_history`, `promotional_terms`, `campaign_start_date`, `campaign_end_date`, `category_metadata`) | deferred — left at column default/`null` |

**`listing_private_details`** — a row is always created (so future edits have something to attach to), but every field is deferred this pass: `purchase_date`, `purchase_price`, `retailer_or_seller`, `serial_number`, `handover_instructions`, `private_category_metadata` all `null`.

**`listing_availability`** — deferred entirely; zero rows are created per new listing (genuinely optional/one-to-many — no date-blocking UI exists yet).

**`listing_requirements`** — a row is always created. `deposit_basis` defaults to `'fixed'`; `requested_deposit_amount` is **derived** from the wizard's existing Requirements-step `deposit_amount` field; `final_deposit_amount` is **server-computed**, always `null` at creation (also enforced by the Phase 0 trigger regardless of what's sent). Every renter-requirement/usage/damage/cancellation field beyond that is deferred at its column default.

**`listing_media`** — photos map to rows with `type = 'photo'`, `display_order` preserved, the first photo tagged `shot_type = 'primary'`. If defects are declared, a checkbox on the Photos step lets the merchant confirm one of their uploads shows the damage — the last uploaded photo in that case is tagged `shot_type = 'damage_closeup'` (a heuristic, not full per-photo shot-type tagging UI, which is deferred). The ownership-proof file maps to one row with `type = 'ownership_proof'`, uploaded to the private `ownership-proofs` bucket — the first real code in the repo to use it.

**`listing_declarations`** — six new checkboxes (Review step), one per `declaration_type`. `merchant_id`, `accepted_at`, `declaration_version`, and `declaration_text_hash` are **all server-computed** from a server-owned catalogue (see below) — the client only sends `accepted: true` per type it checked.

**`listing_moderation`** — one row created at *submission* time (not draft time), `moderation_status = 'pending'`, entirely server-computed. No merchant-facing UI this pass (the read-only `listing_moderation_merchant_view` display is a later, separate addition — this pass is about writing, not displaying, moderation state).

**`listing_history`** — two server-written rows: `listing_created_as_draft` (first save) and `listing_submitted_for_review` (on submit), `changed_by = auth.uid()`.

**`categories`/`subcategories`** — read-only lookup this pass; no admin UI (out of scope, matches "do not build category administration UI").

### Fields that must never be accepted from the client

`merchant_id` (every table), `ownership_verified`, `risk_tier`, `listings.status` beyond `draft`/`pending`, `listing_requirements.final_deposit_amount`, all of `listing_moderation`, `listing_declarations.merchant_id`/`accepted_at`/`declaration_version`/`declaration_text_hash`, `listing_history.changed_by`, `category_id`/`subcategory_id` (resolved server-side from a validated slug, never accepted as a raw client-supplied UUID), and every storage object path (server-generated, never client-supplied — see Storage implementation in the completion report).
