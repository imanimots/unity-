# SEO Pre-Launch Hardening

Implements the parts of Unity SEO Strategy v2.0 that can be safely completed
without a permanent domain, Search Console, analytics accounts, final legal
approval, or real inventory at scale. **Indexing is not enabled by this
work** — see "Indexation gate" below.

## Test fixture isolation

`listings.is_test boolean not null default false` (additive migration,
`supabase/migrations/20260821000001_listings_is_test_column.sql`). Backfilled
for every listing whose title begins `[QA]`/`[DEMO]`, or whose owning
account's email ends in `@unitytest.internal` (the current
`scripts/qa-seed.mjs` domain) or `@unitytest.co.za` (an earlier, superseded
QA domain — e.g. the `phase2a-merchant-a` fixture). Verified live before
writing the migration: every one of the 124 listings in the dev project
matches one of these rules — zero false positives, zero false negatives.

No client-facing create/edit path can ever set this column — `save_listing_draft()`
extracts only explicitly named fields from its jsonb payload and has never
referenced `is_test`. It is migration/service-role-set only.

Every real public listing query path excludes it: `getListings()`,
`getSimilarListings()` (both via a shared `excludeTestListings()` helper in
`src/lib/data/listings.ts`), and `GET /api/affiliate/listings` (the affiliate
opportunity feed). `getListingsByMerchant()` defaults to excluding test
listings too, except the two private "manage my own listings" dashboard call
sites (`dashboard/merchant/page.tsx`, `dashboard/merchant/listings/page.tsx`),
which pass `{ includeTest: true }` explicitly so a merchant's own fixture
(e.g. the `[DEMO] Affiliate Camera Listing`) stays visible to them. Admin
queries are untouched — admin tooling always sees everything.

`getListing()` (single-id detail lookup) is deliberately **not** filtered —
an unlisted, non-indexed fixture staying reachable by its owner or a
regression script is fine; it's absent from every *listing* surface
(grid/search/recommendations/sitemap), which is what matters.

## Fabricated ratings

`profiles.unity_score` is real — a DB-trigger-computed trust score
(`update_unity_score()`), not fabricated. The actual bug was narrower:
`listing-card.tsx` computed `reviewCount = Math.floor(score * 8 +
listing.id.length)` — a number with zero relationship to any real review,
displayed as `(76)`. There is no genuine item-level review in this schema at
all (`reviews` is merchant-scoped via `reviewee_id`, and has 0 rows live).

Replaced with `src/lib/listings/rating-display.ts`'s
`deriveListingRatingDisplay()`, which never derives a count from anything —
it only ever passes through a genuine `{ averageRating, reviewCount }` a
caller already has. No caller has one today, so listing cards currently
render no rating at all (one of the two explicitly allowed outcomes: "omit
the rating entirely"). Forward-compatible: once real per-listing reviews
exist, a caller passes the real aggregate with zero changes to this file.

## Misleading public claims

Removed "thousands of items to rent near you" from the root layout
description (confirmed live: 0 of 124 dev-project listings are real,
non-test inventory — see the Phase 8 SEO report for the full audit).
`booking-card.tsx` and the public listing-detail trust card both said
"Secure checkout — deposit released after return confirmed" /"Payment
authorized until return confirmed" with no test-mode disclosure on a page
any anonymous visitor can reach; both now read "Test checkout — payments are
simulated during Unity's public test," matching the wording
`sale-summary-card.tsx` already used correctly.

## Indexation gate

`src/lib/seo/config.ts` — the one place indexation state and the app's own
URL are read from. Two independent, safe-default-`false` flags:

- `SEO_INDEXING_ENABLED` — ordinary brand/informational pages (home,
  ambassadors, approved legal pages). Drives the root layout's default
  `robots` value; any page setting its own `robots` overrides it.
- `SEO_MARKETPLACE_INDEXING_ENABLED` — browse/listing-detail pages,
  independent of the flag above. Turning general indexing on does **not**
  also turn marketplace indexing on.

Neither is enabled by this phase (both default `false`, added to
`.env.example` with no value set, and to `src/lib/env/validate.ts`'s
optional-checks list).

## Permanent noindex surfaces

Independent of both flags above, always noindex: `/login`/`/register`/`/verify`
(`(auth)/layout.tsx`), every dashboard route (`(dashboard)/layout.tsx`,
covers checkout/booking-transaction pages since they live under
`/dashboard/`), every admin route (`admin/layout.tsx`), and `/chat`
(explicit, since it lives under the shared `(marketing)` layout alongside
pages that stay indexable). `X-Robots-Tag: noindex, nofollow` is also sent
on `/api/*`, `/dashboard/*`, `/admin/*` via `next.config.ts`'s `headers()` —
the only mechanism available for `/api`, which returns JSON with no `<head>`.

**Rule applied**: `robots.txt` **Disallows** genuinely private, auth-gated
infrastructure (`/dashboard/`, `/admin/`, `/api/`) — crawlers can't reach it
regardless. Public-but-low-value pages (login/register/chat, draft legal
pages, faceted search) use **noindex** instead and stay crawlable, so that
directive is actually observed rather than being unreachable behind a
Disallow.

## Draft legal pages

`src/lib/seo/legal-metadata.ts`'s `legalRobotsMeta(doc)` returns
`PERMANENT_NOINDEX` whenever a document's registry `status` is `'draft'`
(all 12 documents in `src/lib/legal/registry.ts` today), regardless of the
general indexing flag. Wired into all 12 legal `page.tsx` files' existing
`metadata` object. A document only starts following the general indexation
gate once its own registry entry is explicitly changed to `status:
'approved'` — a real, separate future action, never implied by flipping the
SEO flag.

## robots.txt / sitemap.xml

`src/app/robots.ts`: `Disallow`s private infrastructure plus faceted-search
and affiliate/UTM query-parameter crawl traps (`?q=`, `?sort=`, `?category=`,
`?maxPrice=`, `?mode=`, `?ref=`, `utm_*`). Never a blanket `Disallow: /`.
Only advertises a `sitemap` URL once `SEO_INDEXING_ENABLED=true` — doing so
earlier would misrepresent a public-test deployment as indexing-ready.

`src/app/sitemap.ts`: returns an empty sitemap while `SEO_INDEXING_ENABLED`
is off (correct — nothing is indexable right now, and a noindex URL should
never appear in a sitemap). Once enabled, lists the homepage, `/ambassadors`,
and any legal document whose `status` is `'approved'` (using its real
`lastUpdated` field, never a fabricated "today"). Listing/marketplace URLs
are **deliberately never included**, even once marketplace indexing is on —
today's bare-UUID listing URLs are explicitly a future slug/short-ID
migration's concern (see "Next code phase" below); forcing them into a
permanent sitemap now would create URLs needing redirect/invalidation the
moment that phase ships.

## Metadata hygiene

`html lang="en-ZA"`, `meta keywords` removed, `metadataBase` set from
`getAppUrl()`, sitewide `twitter:card: summary_large_image` default.
Per-page Open Graph/Twitter + conditional canonical (only emitted while the
relevant indexing flag is on) added to the homepage, `/listings` (browse —
canonical always points at the bare path regardless of `?q=`/`?category=`/etc.
on the actual URL, so parameter variants never create a second canonical
identity), `/listings/[id]` (real per-listing title/description/image; a
test/QA/DEMO fixture is always noindex here regardless of the marketplace
flag), and `/ambassadors`. The 12 legal pages already had per-page
title/description; their canonical is now emitted via the same
`absoluteUrl()` helper. Broader OG coverage across every remaining page
was deliberately not added this phase — those pages are noindex right now
regardless, and the marginal value doesn't justify the added file count;
worth revisiting once `SEO_INDEXING_ENABLED` is actually turned on.

## Affiliate link compliance

Audited every affiliate/referral-link render site. **Finding: Unity
currently renders zero `<a>` anchors tied to a compensated affiliate link.**
The only affiliate-link surface (`affiliate-button.tsx`) displays the link as
copyable plain text in a `<code>` block for the affiliate to paste
elsewhere — never an anchor Unity itself controls the `rel` attribute of.
Nothing to retrofit; `scripts/verify-seo-prelaunch-safety.mjs` check 18
guards the invariant going forward (fails if a future anchor is added from
an affiliate ref link without `rel="sponsored"`).

## Performance

`next.config.ts` `images.formats` now includes `image/avif` ahead of
`image/webp` (previously WebP-only, Next's default). The persistent
marketplace assistant (`ChatWidget`) previously mounted unconditionally in
the root layout on every page; `src/components/assistant/assistant-widget-loader.tsx`
now defers importing/mounting it until the browser is idle (or the
visitor's first interaction, whichever comes first) via `next/dynamic` +
`requestIdleCallback`. The real per-transaction chat (Phase 3,
`chat-thread.tsx`) is a separate feature, unaffected. `next/image` `sizes`
attributes across the app were audited and found already reasonable (64–120px
thumbnails, responsive 100vw/50vw/25vw grids) — no oversized requests found,
no change made. Lighthouse CI was evaluated and not introduced: no CI
pipeline exists in this repository at all (`.github/` is absent), so adding
it would mean standing up CI architecture from scratch — reported as a later
setup item rather than expanded into this phase's scope.

## Known limitations

- Neither indexing flag is enabled. Turning `SEO_INDEXING_ENABLED=true` before
  a permanent domain, Search Console, real legal approval, and real
  inventory exist would be premature — see the Phase 8 SEO report's
  "exact blockers" section.
- Listing/marketplace URLs are absent from the sitemap even once
  `SEO_MARKETPLACE_INDEXING_ENABLED` is turned on — that's deliberate, not a
  gap (see "robots.txt / sitemap.xml" above).
- `robots.ts`/`sitemap.ts` are statically rendered by Next.js (cached at
  build time, per Next's own documented behavior for these file
  conventions) — an env var flip requires a rebuild/redeploy to take
  effect, matching how every other env-gated flag in this codebase already
  behaves on Vercel.
- `scripts/verify-seo-prelaunch-safety.mjs`'s live-HTTP checks require
  `npm run dev` already running; its DB checks (1–3) require the
  `is_test` migration to already be applied.
