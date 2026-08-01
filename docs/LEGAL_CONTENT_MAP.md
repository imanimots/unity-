# Legal Content Map (Step 7)

The legal and trust layer published for Unity's public test phase. No Legalese-drafted
policy document exists anywhere in this repository — confirmed by a full-repository
inventory before any page was written (see "Content inventory" below). Every page below is
therefore an internal draft, narrow and non-guaranteeing, pending legal review — not an
approved legal position.

## Content inventory (mandatory first step — findings)

Searched the entire `src/` tree for: terms, privacy, POPIA, refund, cancellation, dispute,
prohibited, escrow, deposit, guarantee, insurance, liability, courier, delivery, KYC,
Sumsub, Peach, PayFast, mock payment, test payment, secure payment, trust account,
licensed, verified, ownership verified.

**Existing legal pages found**: none. **Existing Legalese documents found**: none anywhere
in the repository (`docs/`, repo root, or elsewhere). This step is a greenfield build, not
a reconciliation against approved text.

**Broken footer/nav links found**: the footer linked to `/how-it-works`, `/pricing`,
`/trust-and-safety`, `/about`, `/terms`, `/privacy`, `/popia` — of these, only `/listings`
and `/ambassadors` (not linked from the footer, but present elsewhere) actually resolved.
The navbar independently linked to the same broken `/how-it-works` route. All fixed (see
"Footer and navigation" below).

**Misleading/unsupported claims found** (all fixed — see "Unsupported claims removed"):
"escrow" used as an affirmative claim in 12 locations (homepage hero/trust-section/steps,
listing detail page ×2, booking card, listing wizard, merchant payouts label, dispute-form
copy, admin bookings action label, the AI assistant's system prompt/mock responses, and the
AI knowledge base seed content — 6 knowledge-base entries); "PayFast" presented as the live,
integrated payment gateway (assistant chat route + 2 knowledge-base entries) when no live
PayFast integration exists anywhere in the codebase (`docs/PHASE_1_REPORT.md` and
`docs/PAYMENT_ARCHITECTURE.md` confirm MockProvider/PeachPaymentsProvider-stub only); an
invented "up to 50%" cancellation fee and a "10% platform fee" / "weekly on Fridays" payout
schedule in the assistant's mock responses and knowledge base, none of which exist in the
actual booking/payment code (`docs/BOOKING_LIFECYCLE.md`, `docs/PAYMENT_READINESS.md`); a
false "live selfie" KYC requirement in the knowledge base (the real flow, per
`docs/IDENTITY_VERIFICATION.md`, asks for an ID/passport document and proof of address, not
a selfie, and is manually reviewed, not automated).

**Mock-mode wording visible publicly**: the KYC flow already said "Manual test
verification" correctly (Step 4) — confirmed accurate, left unchanged. No other page
disclosed test-mode status prior to this step (see "Test-mode disclosures").

## Pages created

All 12 required routes, all new this step, all `status: draft` in the registry:

| Route | Registry slug | Consent checkpoint(s) |
|---|---|---|
| `/terms` | `terms` | registration |
| `/privacy` | `privacy` | registration, verification |
| `/popia` | `popia` | registration, verification |
| `/rental-terms` | `rental-terms` | booking request |
| `/payments-and-deposits` | `payments-and-deposits` | checkout |
| `/cancellations` | `cancellations` | booking request |
| `/refunds` | `refunds` | checkout |
| `/disputes` | `disputes` | — (no dedicated checkpoint; referenced from others) |
| `/prohibited-items` | `prohibited-items` | listing submission (via existing declarations) |
| `/delivery-and-handover` | `delivery-and-handover` | booking request |
| `/verification-and-trust` | `verification-and-trust` | verification |
| `/contact` | `contact` | — |

Shared chrome: `src/components/legal/legal-page-layout.tsx` (`LegalPageLayout` +
`LegalSection`) — one primary `<h1>` per page (the document title), a version/effective-
date/last-updated/draft-or-approved badge row sourced from the registry (never hand-typed
per page), `max-w-[65ch]` prose width for readable line length, `print:` classes hiding
navigation chrome, a link back to `/contact`.

## Legal registry

`src/lib/legal/registry.ts` — a plain TypeScript constant (`LEGAL_DOCUMENTS`), not a CMS or
database table, per the brief's own "do not over-engineer" instruction. Each entry:
`slug`, `title`, `version` (`0.1` for every entry — first draft), `effectiveDate`,
`lastUpdated`, `status` (`draft` for every entry), `source` (`internal_draft` for every
entry), `route`, `consentContexts`. This is the single source of truth both for the badge
rendered on each page and for `policy_version` resolution when recording an acceptance —
never hand-typed twice.

## Consent architecture

Two mechanisms, deliberately not unified into one, because one already existed and fit:

1. **Listing submission** — reuses the existing `listing_declarations` table and
   `submit_listing_for_review()` RPC (Phase 2A/2B, unchanged this step) — already covers
   ownership authority, condition accuracy, image accuracy, legal-and-safe-item (maps to
   the new Prohibited Items Policy), platform terms (maps to Rental Terms), and off-platform
   transaction policy, each individually versioned and hashed server-side. Only change this
   step: added inline links from the wizard's declaration checklist to `/rental-terms` and
   `/prohibited-items` (`src/app/(dashboard)/dashboard/merchant/listings/new/create-listing-flow.tsx`) so the full policy text is reachable, not just the short declaration sentence.
2. **Everything else** (registration, booking request, checkout, verification) — a new,
   minimal, append-only `legal_acceptances` table (migration
   `20260806000001_legal_acceptances.sql`) plus one route, `POST /api/legal/accept`
   (`src/app/api/legal/accept/route.ts`). `user_id` is always the server-verified session
   user (`getRequestProfile()`) — the browser cannot forge whose acceptance is recorded.
   `policy_version` is always resolved server-side from the registry
   (`resolvePolicyVersions()`) — a client-supplied version field is not even in the Zod
   schema, so it cannot be sent. No `INSERT`/`UPDATE`/`DELETE` RLS policy exists for
   `anon`/`authenticated` — every write goes through the service-role client in this one
   route. The table reuses the existing `prevent_row_mutation()` trigger (Phase 2A) — an
   acceptance record can never be altered or deleted, by any role, service_role included
   (live-verified: a direct service-role `UPDATE` attempt returned `P0001`).

## Registration changes

`src/app/(auth)/register/page.tsx` — after a successful `signUp` + profile upsert, calls
`POST /api/legal/accept` with `{policies: ['terms', 'privacy', 'popia'], context:
'registration'}`. Best-effort (a failure here does not block an already-created account —
the account exists either way; the failure is simply not silently pretended-successful).
The existing consent checkbox (unchecked by default, gating the submit button) was already
correct and unchanged.

## Listing submission changes

Covered above — only the inline policy links were added; the declaration mechanism itself
(checkboxes, versioning, hashing, server-side enforcement) is unchanged Phase 2A/2B
infrastructure.

## Booking request changes

`src/app/(marketing)/listings/[id]/book/booking-flow.tsx` — added a new, unchecked-by-default
checkbox at the review step ("I agree to Unity's Rental Terms, Cancellation Policy, and
Delivery and Handover Terms") gating the "Send booking request" button
(`disabled={submitting || !agreedToTerms}`). On success, records acceptance with
`context: 'booking_request'`.

## Checkout changes

`src/app/(dashboard)/dashboard/renter/bookings/[id]/checkout/checkout-flow.tsx` — the
Step 5 inline test-mode paragraph was replaced with the new shared `TestModeBanner`
component (canonical wording, no drift between surfaces). Added a new, unchecked-by-default
checkbox before the pay/retry button ("I agree to the Payment and Deposit Policy and Refund
Policy, and understand this is test mode") gating the button
(`disabled={submitting || !agreedToPaymentTerms}`). On a non-error response, records
acceptance with `context: 'checkout'`.

## Verification changes

`src/app/(auth)/verify/kyc-flow.tsx` — added a new, unchecked-by-default checkbox on the
documents step, folded into the existing `canSubmit` gate
(`canSubmit = (identityDoc || hasIdentityDocOnFile) && (proofOfAddress ||
hasProofOfAddressOnFile) && agreedToVerificationTerms`). On successful submit, records
acceptance with `context: 'verification'` for `popia` and `verification-and-trust`. The
existing "Manual test verification" wording (Step 4) was already accurate and is unchanged.

## Footer and navigation

`src/components/shared/footer.tsx` rewritten to exactly the required grouping — Platform
(How It Works → `/#how-it-works`, Browse → `/listings`, Become a Merchant →
`/register?role=merchant`), Trust (Verification & Trust, Prohibited Items, Disputes), Legal
(all 8 policy pages), Support (Contact). The prior Company group (About, Ambassadors) was
dropped — neither is in the brief's required footer structure, and `/about` never existed
as a route.

`src/app/(marketing)/page.tsx` gained `id="how-it-works"` on its existing "How It Works"
section (section 4) so the anchor genuinely resolves; both the footer's and — found only
during live validation, not the static-search inventory — the **navbar's** own separate
`/how-it-works` link were fixed to `/#how-it-works`. This second broken link was not visible
from source inspection alone (it wasn't in the footer file the initial inventory focused
on); it was caught by rendering the homepage live and diffing every `href="/..."` against
the route filesystem, which is the reason live validation matters as a distinct step from
static inventory.

## Test-mode disclosures

`src/components/shared/test-mode-banner.tsx` — one canonical component, fixed wording:
*"Unity is currently operating in test mode. No real payments, deposits or payouts are
processed."* Placed at: checkout (`checkout-flow.tsx`), `/payments-and-deposits`,
`/refunds`, `/disputes`, the renter and merchant booking dashboards (`.../bookings/page.tsx`
×2), the merchant payouts page (fully mock-data page, out of scope to rewire this step, but
the banner makes the mock figures honest), and the admin bookings page (also a pre-existing
fully-mock admin scaffold, same treatment). Not placed on public marketing pages that don't
touch money (homepage, listing browse) — the homepage's trust-section badge was reworded
instead ("TEST-MODE CHECKOUT") rather than adding the full banner box there, per the
brief's own "do not make the public site look broken" instruction.

## Unsupported claims removed

Full list and replacement wording — see "Content inventory" above for what was found;
concretely, per file:

- `src/app/layout.tsx`, `src/app/(marketing)/page.tsx` — metadata descriptions, hero
  subheadline, "How It Works" step copy, and the "ESCROW PAYMENTS"/"KYC VERIFIED" trust
  badges → "identity-reviewed", "test-mode checkout", "IDENTITY REVIEWED".
- `src/app/(marketing)/listings/[id]/page.tsx` — deposit description and "Escrow protected"
  trust badge → "Authorized at checkout... released when...", "Secure checkout".
- `src/components/listings/booking-card.tsx` — "Payment held in escrow" → "Secure checkout
  — deposit released after return confirmed".
- `src/app/(dashboard)/dashboard/merchant/listings/new/create-listing-flow.tsx` — deposit
  helper text escrow claim fixed.
- `src/app/(dashboard)/dashboard/merchant/payouts/page.tsx` — "In Escrow" stat label →
  "Pending Release"; `TestModeBanner` added (the whole page is pre-existing mock data,
  rewiring it to real data is out of scope — "merchant payouts UI" is explicitly listed
  under Step 7's own "Do not build").
- `src/components/trust/dispute-form.tsx` — "will hold the deposit in escrow" → "will not
  release a held deposit until resolved".
- `src/app/admin/bookings/page.tsx` — "Release Escrow" button → "Release Deposit (test)";
  `TestModeBanner` added (also a pre-existing fully-mock admin page, same treatment).
- `src/app/api/assistant/chat/route.ts` — system prompt and 6 of 11 mock response branches
  rewritten (escrow, PayFast-as-live, invented cancellation percentage, invented payout
  schedule, selfie-KYC claim all removed); added an explicit system-prompt instruction never
  to state these going forward, including for the real-Claude-API path (`BASE_SYSTEM_PROMPT`).
- `src/lib/assistant/seed-data.ts` — 6 of 17 knowledge-base entries rewritten ("Escrow
  payment system" replaced with "How payments currently work (test mode)"; "PayFast payment
  methods" replaced/folded in; "Merchant payout schedule" replaced with "Merchant payouts
  (test mode)"; cancellation, deposit, and platform-fee entries corrected to remove invented
  figures). Confirmed live: the `knowledge_base` table in the dev Supabase project is
  currently empty (never seeded), so no stale DB rows needed correcting — only the source
  file, which will seed correctly whenever an admin next runs the seed action.
- `src/lib/mock/conversations.ts` — one mock chat message's escrow claim softened.

**Deliberately not weakened**: "encrypted transport", "private document storage",
"server-authoritative permissions", "identity reviewed by Unity" — all still stated
accurately on `/verification-and-trust` and `/privacy`.

## Outstanding Legalese review items

Every one of the following needs real legal review before this platform leaves public test:

1. All 12 pages in full — they are narrow, accurate-to-the-code drafts, not reviewed legal
   positions.
2. **Registered company name and registration number** — genuinely unavailable anywhere in
   this repository or its docs. `/contact` states this explicitly as "to be confirmed"
   rather than fabricating a number. This is the one item closest to the brief's stop
   condition ("company legal details are unavailable") — judged not to block the whole step
   (the rest of the legal layer does not depend on it), but it is the single highest-priority
   Legalese/company-secretarial follow-up.
3. Exact data-retention periods (privacy/POPIA pages currently say "as required for legal,
   fraud, dispute and operational purposes" per the brief's own instruction for this case).
4. Cross-border data processing confirmation (privacy/POPIA pages currently say this is not
   yet confirmed).
5. Dispute response-period lengths (not yet finalized anywhere in the codebase).
6. Support hours and formal response-time commitments (`/contact` currently states a
   response *target*, explicitly not a guarantee).
7. Large-item/vehicle-specific delivery and handover rules (not yet defined).
8. Final live-payment-provider terms and refund timing once a real provider (Peach or
   otherwise) is selected — `/payments-and-deposits` and `/refunds` are written narrowly
   enough not to need rewriting when that happens, but should be re-reviewed at that point.
9. The immutability-blocks-deletion interaction on `legal_acceptances` (see "Known
   limitations") should be reviewed against POPIA's right-to-erasure once an account-deletion
   feature is built.

## Tests

35 new tests (490 total project-wide, all passing): `registry.test.ts` (9 — completeness,
draft status, `resolvePolicyVersions` never invents a version), `content-scan.test.ts` (7 —
no forbidden affirmative claim anywhere in app/component/assistant source, no PayFast-is-live
claim, no invented selfie-KYC claim, no invented cancellation percentage, every legal page
exists/renders via `LegalPageLayout`/sets a canonical route), `footer-links.test.ts` (7 —
every footer group present, every internal link resolves to a real page file, every
required legal/trust/support route is actually linked, the stale routes are gone, the
navbar's separate link is also fixed), `consent-architecture.test.ts` (12 — every one of the
4 checkpoints calls the route with the right context and an explicit unchecked-by-default
gate, listing submission correctly does NOT call the new route, the route's own schema/trust
boundary, the migration's RLS/immutability/context-enum invariants read directly from the
SQL text).

## Live validation

Performed against the local dev server and the dev Supabase project (not production):

1. All 12 legal routes browsed anonymously → `200` each.
2. Homepage anchor (`#how-it-works`) present and working; **found and fixed a second broken
   link** (`navbar.tsx`'s own separate `/how-it-works`, not caught by the footer-only static
   scan) — demonstrates why live rendering was checked in addition to source inspection.
3. Registration consent: public `signUp` was rejected by this Supabase project's own email
   validation (a pre-existing environment setting unrelated to this step's code — confirmed
   by testing multiple email formats and confirming *existing* QA-account sign-*in* still
   works fine); worked around via `auth.admin.createUser` to create a fresh test account,
   then drove `POST /api/legal/accept` exactly as the registration page's client code does →
   `200 {"recorded":["terms","privacy","popia"]}`, confirmed as 3 rows in `legal_acceptances`
   with `policy_version: "0.1"` (the registry's current value) and `context: "registration"`.
4. Listing/booking/verification page shells all render `200` post-edit (full authenticated
   walk-throughs of booking/checkout/verification were already proven working in Steps 5/6;
   this step only added consent checkboxes to already-tested flows, verified via the
   `consent-architecture.test.ts` suite plus these render checks).
5. Footer links verified from the rendered homepage HTML: every required route present, no
   stale routes remain.
6. Rendered-page search for unsupported claims: `0` matches for "escrow" (or any of the
   other forbidden phrases) on the rendered homepage and listing detail page.
7. **Security**: unauthenticated `POST /api/legal/accept` → `401`. A forged
   `"policy_version":"99.9"` field in the request body was silently ignored — the inserted
   row still shows the registry's real `"0.1"`. A repeated acceptance created a **new** row
   (append, not overwrite) — 4 rows total for the test user after a second `terms`
   acceptance, not 3. A direct `PATCH` to `legal_acceptances` as the authenticated test
   user's own session affected `0` rows (no RLS write policy at all). A direct `PATCH` via
   the **service-role** key was still rejected — `P0001 "legal_acceptances records are
   immutable and cannot be updated or deleted"` — confirming the immutability trigger holds
   even for the most privileged role.
8. Draft/approved labels: `/terms` (and, by construction, every other page) renders
   `Version 0.1`, `Effective 6 August 2026`, and the amber `Draft — pending legal review`
   badge, matching the registry's `status: 'draft'` for every entry.

## Files changed

~38 files: 1 migration, 1 registry module, 2 shared components (`LegalPageLayout`,
`TestModeBanner`) + 1 small display component (`PaymentDeadlineNote` was pre-existing from
Step 6, unchanged), 12 legal page files, 1 new API route (`/api/legal/accept`), 4 files
wiring consent checkboxes (register, booking-flow, checkout-flow, kyc-flow), footer +
navbar, ~11 files with claim corrections, 5 new test files, this doc, and small updates to
`.gitignore` (temporary QA scratch dir, already reverted).

## Migrations

One: `supabase/migrations/20260806000001_legal_acceptances.sql` — additive only (`create
table if not exists`), applied and live-verified against the dev Supabase project.

## Build health

`tsc --noEmit` clean. `npm run build` clean — all 12 legal pages statically prerendered
(`○`). `vitest run` — 490/490 passing (35 new). `eslint` on every changed file — zero new
findings; project-wide baseline unchanged at 19 (the same pre-existing findings from before
this step, none touched by these changes).

## Known limitations

- The `legal_acceptances` immutability trigger (correct for an audit trail) means a user
  with any recorded acceptance cannot have their `auth.users` row deleted via the standard
  cascade — live-confirmed when cleaning up the Step 7 test account
  (`auth.admin.deleteUser` failed with a database error). Not a bug in this step's design —
  it's the direct, correct consequence of "acceptance records append rather than overwrite,
  ever" — but it is a real interaction a future account-deletion / POPIA right-to-erasure
  feature will need to resolve (likely: anonymize the profile rather than delete it, leaving
  the acceptance audit trail intact under a tombstoned user id).
- Public registration (`supabase.auth.signUp`) is currently rejected by this specific dev
  Supabase project's email validation for newly-generated test addresses — an existing
  environment configuration, not something this step's code touches. Existing QA accounts
  are unaffected (sign-in confirmed working). Flagged for whoever manages the Supabase
  project's Auth settings, not a Legalese item.
- The merchant payouts page and the admin bookings page are both pre-existing, fully mock
  scaffolds (`MOCK_MERCHANT_BOOKINGS`, `ADMIN_MOCK_BOOKINGS`) never wired to the real
  financial architecture built in Steps 5/6. This step added the test-mode banner and fixed
  misleading labels on both, but did not rewire their underlying data — "merchant payouts
  UI" and broader admin operations are explicitly out of scope for Step 7.
- The Ambassador Program page (`/ambassadors`) and internal Affiliate Program were not part
  of this step's flagged-term search (the brief's search list does not mention "affiliate"
  or "ambassador") and were left untouched, including a knowledge-base entry that still
  states affiliate program details without a test-mode caveat — worth a follow-up pass if
  Step 8/9 touches the affiliate system.
