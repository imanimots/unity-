# Unity — Phase 1 Architecture Report

Scope: the 6 architecture changes requested before Phase 2 feature work
begins. No feature UI/API for buying & selling was built — that table is
schema-only per instruction ("create the database design before
implementing code"). Full rationale for the two biggest design decisions
lives in `docs/RISK_ENGINE.md` and `docs/BUYING_SELLING.md`; this report
summarizes and points there rather than repeating them.

## 1. Architecture decisions

- **Credit scoring removed, not deprecated.** `requires_credit_score` /
  `min_credit_score` are gone from the DB, types, UI, docs, and AI knowledge
  base — not hidden or left as dead fields. See §2.
- **Risk tier is enforced at the database layer, not just the app layer.**
  A Postgres trigger recomputes `listings.risk_tier` on every insert/update
  and ignores whatever a client sends for that column. This was a
  deliberate choice over an application-layer-only check: it holds even
  against a future code path that forgets to strip the field, or a direct
  DB write. Full rule set in `docs/RISK_ENGINE.md`.
- **Buying & selling extends `listings`, adds a parallel `orders` table,
  and makes `reviews`/`disputes`/`messages` dual-purpose** rather than
  merging into `bookings` or duplicating trust & safety infrastructure.
  Full trade-off analysis in `docs/BUYING_SELLING.md`. This was schema-only
  — no `Order` TypeScript type, API route, or UI was built.
- **API security fixes prioritized real vulnerabilities over blanket
  hardening.** The two routes with unauthenticated service-role writes
  (`affiliate/referral`, `assistant/embed`) got real fixes (auth + input
  revalidation from the DB, not the client). The two public/anonymous-by-design
  routes (`assistant/chat`, `assistant/search`) got input validation, size
  caps, and rate limiting rather than an auth requirement, since they're
  meant to serve unauthenticated visitors.
- **Admin authorization is now checked in two independent places** —
  `src/lib/supabase/proxy.ts` (middleware, first line of defense) and
  `src/app/admin/layout.tsx` (server component, authoritative) — rather
  than one. The client-side `localStorage.unity_admin` flag is gone
  entirely, not supplemented.
- **Git is now initialized with a baseline commit taken before any Phase 1
  edits**, so the diff between "audited state" and "Phase 1 architecture
  state" is inspectable via `git diff` rather than only described in prose.

## 2. Database changes

Three new migration files (not yet applied to the live Supabase project —
apply via Supabase Dashboard → SQL Editor, same convention the existing
migrations already use):

**`20260720000001_remove_credit_score.sql`**
- Drops `listings.requires_credit_score`, `listings.min_credit_score`.

**`20260720000002_risk_engine.sql`**
- Adds `risk_tier` enum (`low`/`medium`/`high`) and `listings.risk_tier`
  column, default `'low'`.
- Adds `compute_listing_risk_tier()` trigger function + `BEFORE INSERT OR
  UPDATE` trigger on `listings` — this is the sole writer of that column.
  Rules: category floor (vehicles=high, tech/tools/fashion/music=medium,
  else low) combined with value tier from `daily_rate` (< R500/day low,
  R500–2499 medium, ≥ R2500 high), then raised one tier if the merchant's
  `kyc_status !== 'approved'` or `unity_score < 3.0`.
- Backfills existing rows via a no-op update that fires the trigger.

**`20260720000003_buying_selling_schema.sql`**
- `listings` gains `listing_type` enum (`rental`/`sale`, default
  `rental`), `sale_price`, `quantity_available`; `daily_rate` becomes
  nullable; a `CHECK` constraint enforces exactly one pricing shape per
  row.
- New `orders` table (buyer/seller, quantity, pricing, `order_status`
  enum, PayFast/affiliate fields) with RLS mirroring `bookings`.
- `reviews`, `disputes`, `messages` gain a nullable `order_id` alongside
  the now-nullable `booking_id`, with a `CHECK` enforcing exactly one is
  set; RLS policies extended to match via either party.
- `affiliate_referrals` gains a nullable `order_id`.

**Not applied yet.** These are new files in `supabase/migrations/`
following the existing repo convention (comment header: "Apply via:
Supabase Dashboard → SQL Editor → Run"). I did not run them against the
live project — `.env.local` holds real, privileged Supabase credentials for
a shared external database, and applying schema changes there is a
one-way-door action I'm not taking without your explicit go-ahead. Say the
word and I'll apply them (or you can paste them into the SQL Editor
yourself).

## 3. Files modified

**Removed:**
- `src/lib/supabase/middleware.ts` — dead duplicate of `proxy.ts`, unused
  by anything (verified via repo-wide grep before deletion), flagged in
  the original audit as a confusion risk.

**Added:**
- `supabase/migrations/20260720000001_remove_credit_score.sql`
- `supabase/migrations/20260720000002_risk_engine.sql`
- `supabase/migrations/20260720000003_buying_selling_schema.sql`
- `docs/RISK_ENGINE.md`, `docs/BUYING_SELLING.md`, `docs/PHASE_1_REPORT.md`
- `src/lib/risk/engine.ts` — TS mirror of the DB trigger rules, used for
  client-side preview only (DB trigger is authoritative)
- `src/lib/supabase/require-admin.ts` — shared `requireAdmin()` /
  `getRequestProfile()` helpers, used by both the admin layout and the
  `assistant/embed` route
- `src/lib/rate-limit.ts` — minimal in-memory rate limiter (see §4, Risks)
- `src/app/admin/admin-shell.tsx` — the interactive sidebar/nav UI, split
  out of `layout.tsx` so the layout itself can be a server component

**Modified — credit score removal:**
- `src/types/index.ts` — removed the two fields, added `RiskTier` type and
  `Listing.risk_tier`
- `src/lib/mock/data.ts` — removed the fields from all 16 mock listings;
  `MOCK_LISTINGS` now derives `risk_tier` by calling the real risk engine
  function against each mock listing's own data, rather than being
  hand-set, so mock data exercises the same rules real listings will
- `src/app/(marketing)/listings/[id]/page.tsx` — replaced the credit-check
  requirement block with a risk-tier display (ownership verification /
  insurance requirements)
- `src/app/(marketing)/listings/[id]/book/booking-flow.tsx` — removed the
  `CreditGate` component and its branching; the KYC gate is now a single
  condition; added a risk-tier info banner in the review step
- `src/app/(dashboard)/dashboard/merchant/listings/new/create-listing-flow.tsx`
  — removed the "Require identity verification" toggle from the
  Requirements step; replaced with a read-only, live-computed Risk Tier
  panel (merchants can see it, not set it); Review step now shows the
  computed tier instead of an "ID check" row
- `src/lib/assistant/seed-data.ts` — reworded two knowledge-base entries
  that referenced "credit check" to describe the Risk Engine instead
- `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/PAGES.md`,
  `QUICK_SETUP.md` — removed credit-building/credit-score references,
  added MVP scope notes pointing to `RISK_ENGINE.md` / `BUYING_SELLING.md`,
  added a "Buying & Selling (MVP)" section to `FEATURES.md`

**Modified — API security:**
- `src/app/api/affiliate/referral/route.ts` — now requires an
  authenticated caller; validates the body with zod; **no longer trusts
  the client-supplied commission rate** — always reads
  `listings.affiliate_commission_rate` from the DB and confirms
  `accepts_affiliates` is true before recording a referral; rate-limited
- `src/app/api/affiliate/activate/route.ts` — unchanged behavior, refactored
  onto the shared `getRequestProfile()` helper; rate-limited
- `src/app/api/assistant/embed/route.ts` — now requires an admin session
  (`requireAdmin()`); zod-validated body; rate-limited. This was the
  unauthenticated knowledge-base-write vulnerability flagged in the audit
- `src/app/api/assistant/search/route.ts` — zod-validated body; the ILIKE
  fallback now escapes `%`/`_` so user input can't broaden its own search
  pattern; rate-limited
- `src/app/api/assistant/chat/route.ts` — zod-validated body (message
  count capped at 20, each message capped at 4,000 chars, `pageUrl`/
  `knowledgeContext` size-capped); rate-limited. Left unauthenticated on
  purpose — it's the public support chat, meant to work for anonymous
  visitors

**Modified — admin authorization:**
- `src/lib/supabase/proxy.ts` — `/admin` added to protected paths (redirect
  to `/login` if unauthenticated); added a `profiles.role === 'admin'`
  check for any authenticated non-admin hitting `/admin/*` (redirect to `/`)
- `src/app/admin/layout.tsx` — rewritten as an async server component that
  calls `requireAdmin()` and redirects if it fails; renders the new
  `AdminShell` client component. This is the authoritative check —
  `proxy.ts` is defense-in-depth, not the primary control

## 4. Risks

- **Migrations are written but not applied.** The live Supabase project
  doesn't have `risk_tier`, `listing_type`, `orders`, etc. yet. The app
  code (`src/lib/risk/engine.ts`, `Listing.risk_tier` in types) assumes
  they exist. This is intentional per §2, but it means nothing here is
  "live" until you apply the three migration files.
- **No admin user exists yet.** Real (non-mock) `/admin` access now
  requires a `profiles.role = 'admin'` row. There's no self-serve way to
  become admin (correctly — it shouldn't be self-serve), which means
  someone needs to manually set a profile's role in the DB before the
  admin panel is reachable outside mock mode. Flagging so it isn't a
  surprise on first real-mode admin login attempt.
- **The rate limiter is process-local, in-memory state.** On Vercel's
  serverless model, different invocations can land on different instances,
  so it does not enforce a real global limit in production — it's
  defense-in-depth for a single long-lived process (local dev, a
  persistent Node server), not a production control. Documented in the
  file itself (`src/lib/rate-limit.ts`). Recommend Upstash Redis (or
  similar shared store) before relying on this for real abuse prevention.
- **`affiliate/referral`'s `rentalFee` is still client-supplied.** I
  removed trust in the client-supplied *commission rate* (now always read
  from the DB), but `rentalFee` itself has nowhere authoritative to check
  against yet, because — per the original audit — no booking is actually
  persisted anywhere in the app today. Full server-side recomputation of
  this needs real booking persistence, which is Phase 2 feature work, not
  a Phase 1 architecture gap I could close here. It's now at least
  bounded (positive number, capped at R1,000,000 via zod) and gated behind
  authentication + rate limiting, which meaningfully narrows the abuse
  window versus the fully open endpoint from before.
- **The risk engine trigger doesn't yet branch on `listing_type`.** It
  only reads `daily_rate`. Once Phase 2 wires up sale listings using the
  schema from `BUYING_SELLING.md`, the trigger needs a matching update to
  use `sale_price` for sale rows — flagged explicitly in
  `RISK_ENGINE.md`'s "Known limitation" section so it isn't lost. Not
  currently exploitable since no sale listings can exist yet (no Phase 2
  code creates them).
- **The SQL trigger and the TypeScript risk module are two independent
  implementations of the same rules** and must be kept in sync by hand;
  the DB trigger is authoritative, so a drift would only mis-preview a
  tier client-side, not misassign it — but it's a maintenance burden
  worth a regression test in Phase 2 (also noted in `RISK_ENGINE.md`).
- **Buying & selling is genuinely just a schema.** There's no `Order`
  type, no purchase UI, no API. Don't read the migration file as "buying
  and selling works now" — it's the foundation Phase 2 builds on.
- **Full production build could not be verified in this sandbox.** `npm
  run build` (Turbopack) hit a Rust memory-allocation failure inside this
  session's constrained shell environment, unrelated to the code itself —
  it's an environment resource limit (Cygwin fork/memory pressure), not a
  compile error. `tsc --noEmit` and `eslint` both passed clean against the
  full changed surface (see §5), which is the meaningful correctness
  signal available here, but a real `next build` in a normal environment
  is worth running before you deploy.

## 5. Testing completed

- `npx tsc --noEmit` — clean, zero errors, across the whole project
  including every file touched in Phase 1.
- `npx eslint src` — 25 pre-existing findings (12 errors, 13 warnings),
  all in files Phase 1 did not touch (`chat-widget.tsx`,
  `country-selector.tsx`, `navbar.tsx`, `use-auth.ts`, `use-kyc.ts`,
  `dispute-form.tsx`, plus one pre-existing `PriceBreakdown`
  inline-component warning in `booking-flow.tsx` that predates this
  change). **Zero new lint errors introduced by Phase 1.**
- `npm run build` — did not complete in this sandbox; see §4, last item.
  Not run to completion, not a pass or fail on the code itself.
- Manual read-through of every edited file's full diff context (not just
  the changed lines) to confirm removed imports/props don't leave dead
  references — e.g. confirmed `UserCheck` and `CreditCard` icon imports in
  `booking-flow.tsx` are both still genuinely used after `CreditGate`'s
  removal, confirmed no remaining `unity_admin`/`localStorage` admin-gate
  references anywhere in `src/`, confirmed no other file imports the
  deleted `lib/supabase/middleware.ts` before removing it.
- Did not start the dev server / exercise this in a browser — the
  underlying features (booking, listing publish) still don't persist
  anything (a pre-existing gap from the original audit, not something
  Phase 1 was scoped to fix), so a manual click-through wouldn't exercise
  the DB-level changes (trigger, RLS) meaningfully until the migrations
  are applied to a real project. Recommend testing the trigger directly
  in the Supabase SQL Editor after applying the migrations (insert a test
  listing at a few price points/categories, confirm `risk_tier` lands
  where `RISK_ENGINE.md`'s table predicts) before Phase 2 builds on top of
  it.

---

Waiting for your approval before starting Phase 2.
