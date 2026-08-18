/**
 * Explicit, hand-classified manifest of every route under src/app/[locale]
 * (the customer/merchant-facing route tree; Admin lives entirely outside
 * [locale] and is excluded by construction, not by an entry here).
 *
 * Classification values:
 *  - 'wired'          -- the page.tsx itself calls useTranslations/
 *                         getTranslations and renders dictionary-sourced
 *                         copy directly.
 *  - 'shared-layout'   -- the page renders through a shared component that
 *                         IS wired (e.g. LegalPageLayout) -- its chrome is
 *                         genuinely localized even though the page.tsx
 *                         file itself doesn't import next-intl directly.
 *                         The legal BODY text is deliberately excluded
 *                         from this (English-authoritative, see
 *                         docs/I18N_GLOSSARY.md) -- 'shared-layout' here
 *                         describes the chrome, not a claim that the
 *                         body is translated.
 *  - 'unwired'         -- still hardcoded English; dictionaries may exist
 *                         for its domain but nothing on this specific page
 *                         consumes them yet.
 *
 * This file is the single source of truth verify-i18n.mjs's page-coverage
 * check reads -- extend it (never delete an entry) as pages are wired, so
 * the denominator can never silently drift from the real route tree.
 */
export type PageCoverageStatus = 'wired' | 'shared-layout' | 'unwired'

export interface PageCoverageEntry {
  path: string
  status: PageCoverageStatus
  note?: string
}

export const PAGE_COVERAGE_MANIFEST: PageCoverageEntry[] = [
  // ---------------- AUTH ----------------
  { path: '(auth)/login/page.tsx', status: 'wired' },
  { path: '(auth)/register/page.tsx', status: 'wired' },
  { path: '(auth)/verify/page.tsx', status: 'wired' },

  // ---------------- DASHBOARD (renter/shared) ----------------
  { path: '(dashboard)/dashboard/affiliate/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/barter/[id]/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/barter/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/barter/skill-task/[id]/edit/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/barter/skill-task/[id]/offers/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/barter/skill-task/new/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/barter/skill-task/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/disputes/[id]/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/disputes/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/orders/[id]/checkout/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/orders/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/rent-to-buy/[id]/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/rent-to-buy/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/renter/bookings/[id]/checkout/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/renter/bookings/[id]/dispute/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/renter/bookings/[id]/media/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/renter/bookings/[id]/review/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/renter/bookings/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/renter/page.tsx', status: 'wired' },

  // ---------------- DASHBOARD (merchant) — wired this delta ----------------
  { path: '(dashboard)/dashboard/merchant/advertising/[id]/page.tsx', status: 'wired' },
  // Gap-closure pass: genuinely wired now (advertising.create dictionary
  // section + useTranslations throughout). Was briefly 'unwired' after the
  // prior pass's audit caught it having zero translation calls.
  { path: '(dashboard)/dashboard/merchant/advertising/new/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/advertising/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/commissions/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/listings/page.tsx', status: 'wired' },
  // Gap-closure pass: genuinely wired now (merchant.subscriptionPage
  // dictionary section + useTranslations throughout, formatDate replacing
  // the hardcoded toLocaleDateString('en-ZA') calls).
  { path: '(dashboard)/dashboard/merchant/subscription/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/affiliates/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/bookings/[id]/dispute/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/bookings/[id]/review/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/bookings/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/listings/[id]/rent-to-buy/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/listings/new/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/orders/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/merchant/payouts/page.tsx', status: 'wired' },
  { path: '(dashboard)/dashboard/personalization/page.tsx', status: 'wired' },

  // ---------------- MARKETING (public) ----------------
  // Gap-closure pass: genuinely wired now (common.home dictionary section,
  // hero/marquee/steps/features/trust/final-CTA + generateMetadata all
  // reading from it). Was briefly 'unwired' after the prior pass's audit
  // caught it as ~100% hardcoded English despite the earlier false claim.
  { path: '(marketing)/page.tsx', status: 'wired' },
  { path: '(marketing)/ambassadors/page.tsx', status: 'wired' },
  { path: '(marketing)/barter/skill-task/[id]/page.tsx', status: 'wired' },
  { path: '(marketing)/chat/page.tsx', status: 'wired' },
  { path: '(marketing)/listings/[id]/book/page.tsx', status: 'wired' },
  { path: '(marketing)/listings/[id]/buy/page.tsx', status: 'wired' },
  { path: '(marketing)/listings/[id]/page.tsx', status: 'wired' },
  { path: '(marketing)/listings/page.tsx', status: 'wired' },
  { path: '(marketing)/looking-for/[id]/page.tsx', status: 'wired' },
  { path: '(marketing)/looking-for/new/page.tsx', status: 'wired' },
  { path: '(marketing)/pricing/page.tsx', status: 'wired' },
  { path: '(marketing)/profile/[id]/page.tsx', status: 'wired' },

  // ---------------- LEGAL (12 pages, chrome wired via LegalPageLayout) ----------------
  { path: '(marketing)/terms/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/privacy/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/popia/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/rental-terms/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/payments-and-deposits/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/cancellations/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/refunds/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/disputes/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/prohibited-items/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/delivery-and-handover/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/verification-and-trust/page.tsx', status: 'shared-layout' },
  { path: '(marketing)/contact/page.tsx', status: 'shared-layout' },
]

export function summarizePageCoverage() {
  const total = PAGE_COVERAGE_MANIFEST.length
  const wired = PAGE_COVERAGE_MANIFEST.filter((p) => p.status === 'wired').length
  const sharedLayout = PAGE_COVERAGE_MANIFEST.filter((p) => p.status === 'shared-layout').length
  const unwired = PAGE_COVERAGE_MANIFEST.filter((p) => p.status === 'unwired').length
  return { total, wired, sharedLayout, unwired, localizedTotal: wired + sharedLayout }
}
