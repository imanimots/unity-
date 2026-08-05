# Step 11 Phase 1 — Foundation Widening and Real Country Filtering

Phase 1 of Step 11 (see the approved plan for the full 8-phase roadmap). Scope: shared database foundations later Chat/Disputes/Barter/Email phases depend on, and making the country selector genuinely control listing discovery. No user-facing chat, disputes, or barter financial features were built in this phase.

## Schema changes

All four migrations were verified live against the dev Supabase project (not assumed from source text) both before and after applying.

### `20260813000001_step11_phase1_barter_widening.sql`

**`messages`**: added `barter_agreement_id uuid null references barter_agreements(id)`. Replaced `messages_one_transaction_chk` with a 3-way exactly-one-of across `booking_id`/`order_id`/`barter_agreement_id`. Both `"messages: parties read"` and `"messages: parties send"` policies were extended with a third `EXISTS` branch matching `barter_agreements.party_a_id`/`party_b_id = auth.uid()` — messages keeps RLS + session-client writes (no RPC), matching the barter plan's own Decision 6, so both read and write needed the barter branch for Phase 3 to work at all.

**`disputes`**: added the same column and exactly-one-of CHECK. Only `"disputes: parties read"` was extended with a barter branch. `"disputes: parties insert"` was deliberately left untouched — it still only checks booking/order party membership, so a client attempting to insert a barter-flavored dispute row fails RLS even though the CHECK constraint would permit the row shape. Dispute creation for barter agreements is deferred to Phase 2's RPC-based workflow. Verified live: a real party's client-side insert attempt for a barter dispute is rejected; a service-role-inserted test row is readable by both real parties and correctly hidden from a non-party.

### `20260813000002_step11_phase1_email_entity_widening.sql`

Widened `email_deliveries_related_entity_type_check` (the real, confirmed-via-`pg_constraint` name — not a guess) from `('booking','listing','identity_verification')` to add `'order'` and `'barter_agreement'`. Updated `RelatedEntityType` in `src/lib/email/service.ts`. No new templates or event-dispatch call sites — this only widens what the column permits, for Phase 4/6 to use later.

### `20260813000003_step11_phase1_messages_realtime.sql`

`alter publication supabase_realtime add table public.messages`, guarded by a `pg_publication_tables` existence check so the migration is safe to re-run. Verified live: `messages` now appears exactly once in `supabase_realtime`. No other table was touched.

### `20260813000004_step11_phase1_listing_country_fix.sql`

Not originally scoped as a migration, but found during Step 0's live verification: `save_listing_draft`'s INSERT branch read `country_id` directly from the client-supplied `p_listing` JSONB payload with zero validation against the real `countries` table — any authenticated caller of this RPC (reachable directly, not just via the wizard's route) could set an arbitrary/unsupported value. In practice this was never exploited (the wizard frontend never sends this field — confirmed via grep — so all 46 live listings already had `country_id='ZA'` via the coalesce fallback), but the RPC itself is the real security boundary for this table, so it was the right place to fix it. A `CREATE OR REPLACE` of the full function (byte-identical except one line) now derives `country_id` from the merchant's own `profiles.country_id` instead of trusting the client, matching the plan's source order (no explicit wizard country field exists yet, so this skips straight to the profile-derived tier). Verified live end-to-end: calling the RPC with a spoofed `country_id: 'NG'` in the payload still produces a listing with `country_id='ZA'` (the calling merchant's real profile country).

## Payments widening — deferred, not forgotten

`payments.barter_agreement_id` was **not** touched in this phase, per the correction made during plan review: there's no genuine migration-ordering reason to widen a financial table three phases before anything reads the new column. It moves to the start of Phase 4, immediately before Barter Phase B's deposit/cash-adjustment work actually consumes it.

## Country architecture

- **`isSupportedCountry()`** (`src/lib/countries.ts`): true only for a country that's both a known code *and* currently `active` — a "coming soon" code (NG/KE/GH/GB) is treated the same as an unknown one for resolution/validation purposes, since none of them can currently hold real listings or a real preference.
- **`resolveEffectiveCountry()`** (new file, `src/lib/resolve-effective-country.ts` — a sibling of `countries.ts`, not a subdirectory, since `src/lib/countries/` would collide with the existing `countries.ts` file that client components already import from): the one centralized resolver. Order: authenticated profile's `country_id` → the `unity_country` cookie → `NEXT_PUBLIC_DEFAULT_COUNTRY` → hardcoded `'ZA'`. Every tier is validated through `isSupportedCountry()` before being trusted; an invalid/garbage/inactive value at any tier falls through to the next rather than erroring.
- **`PATCH /api/profile/country`** (`src/app/api/profile/country/route.ts`, schema in `src/lib/profile/validation.ts`): the one narrow route for changing a signed-in user's country. Auth via the existing `getRequestProfile()`; body validated by `countryUpdateSchema` (zod); the user id always comes from the session, never the request body; unsupported/unknown codes rejected with 400; the actual `UPDATE` runs through a **session-scoped** client (not service-role), so `profiles: own update` RLS is the real enforcement boundary, not application logic alone. Live-verified: `country_id` is not blocked by `protect_profile_privileged_fields()`, so no new RPC was needed for this non-privileged preference field.
- **`country-selector.tsx`**: now writes both a cookie (`SameSite=Lax`, `Secure` on HTTPS, `path=/`, 1-year lifetime) and `localStorage` on every selection — a cookie is required because Server Components can't read `localStorage`. For an authenticated user (checked via the existing `useAuth()` hook), it also calls the PATCH route after the optimistic local update, and rolls the selection back to the previous value if that call fails. Anonymous users only get the cookie/localStorage write, no profile call. The pre-existing mount-time `useEffect` + `setState` (a `react-hooks/set-state-in-effect` violation predating this phase, caught while touching this file) was fixed to a lazy `useState` initializer, matching the same pattern already established this session for barter's mount-derived state.

## Listing discovery scoping

`getListings()` (`src/lib/data/listings.ts`) gained a `countryId` filter param, applied in both the mock-mode and real-Supabase paths. There are exactly **two** real call sites in the whole app — the homepage's featured listings and the browse/search page — and both now pass `resolveEffectiveCountry()`'s result. Every other listing-fetch function (`getListing()` singular, `getListingsByMerchant()`, `getListingDraftForEdit()`) is untouched and un-filtered by design: a merchant's own dashboard, the admin listings view, and direct listing-detail-by-id must never lose a row just because the browsing country changed — this mirrors the already-established precedent that `getListing()` doesn't apply the barter-lock exclusion `getListings()` does either.

## Live validation performed

25 live checks run against the dev Supabase project and dev server (script discarded after use, no permanent QA fixtures added for this):

- `PATCH /api/profile/country`: anonymous rejected (401); valid update persists to `profiles.country_id` (confirmed via a separate service-role read, not just the response body); unsupported country (`NG`) rejected (400); unknown code (`XX`) rejected (400); non-string body rejected (400); confirmed no other profile column (`role`/`kyc_status`/`account_status`) moved as a side effect.
- `messages` RLS: a real barter party can insert; the other real party can read it; a non-party gets nothing back; a non-party's insert attempt is rejected.
- `disputes` RLS: a service-role-inserted barter dispute row is readable by both real parties and hidden from a non-party; a real party's own client-side insert attempt is still rejected (Phase 2 not built yet).
- Exact-one-of CHECK: a row with two FKs set is rejected; a row with zero FKs set is rejected — for `messages`, tested directly at the database level (service-role bypasses RLS but not CHECK constraints).
- `save_listing_draft`: a spoofed `country_id: 'NG'` in the client payload is ignored; the resulting listing correctly gets the calling merchant's real profile country (`ZA`).
- Cross-country browse leakage: a temporary `country_id='NG'` listing was created, confirmed absent from a `unity_country=ZA`-cookied request to the real `/listings` browse page, then deleted.

## Known limitations

- **Only one active country exists** (`ZA`) — this means "switching between two active countries changes results" (one of the plan's live-validation items) cannot be demonstrated through the real UI today, by design: every other seeded country is `active: false`, and `isSupportedCountry()` correctly rejects a cookie/profile value for any of them, falling through to the `ZA` default regardless. The filtering *mechanism* itself was verified via a temporary non-ZA listing instead (see above) — the mechanism works, there's just nothing else active to switch to yet.
- **One harmless leftover test listing**: `[QA] Phase1 country-spoof test` (`0e37a747-e831-4c87-8e7c-5bef435cf0ac`), status `draft`, `country_id='ZA'`. Created during live validation and could not be deleted afterward — `listing_history`'s `prevent_row_mutation()` trigger blocks the cascading delete `listings` would otherwise need, since `save_listing_draft` always writes a history row on first insert. This is the same class of permanence already encountered this session with orders and barter agreements (append-only audit trail taking precedence over cleanup convenience), not a Phase 1 defect. The row is invisible to browse/moderation (draft status) and clearly labeled.
- **No backfill migration was needed or written**: live query confirmed all 46 existing listings already had `country_id='ZA'` before this phase (the column's own `not null default 'ZA'` already guaranteed this).

## Phase 2 prerequisites now satisfied

`messages` and `disputes` both have a working `barter_agreement_id` column, CHECK constraint, and (for `messages`) full read/write RLS ready for Phase 3's real chat to use immediately. `disputes`' read-only extension and untouched insert policy set up exactly the boundary Phase 2 needs to replace with a proper RPC-based creation flow. `email_deliveries` can now record an `order` or `barter_agreement` related entity once Phase 4/6 add real events. `messages` is in the Realtime publication, ready for Phase 3's subscription.
