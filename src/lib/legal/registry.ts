/**
 * The simple legal-document registry (Step 7) -- a plain TS constant, not
 * a CMS or a database table, per the brief ("do not over-engineer with a
 * CMS unless one already exists"). This is the single source of truth for
 * each policy's version/effective-date/approval-status metadata, used
 * both to render the badge on each legal page and to resolve
 * `policy_version` when recording an acceptance (POST /api/legal/accept)
 * -- the version stamped into `legal_acceptances` always comes from here,
 * never from the client.
 *
 * No Legalese-drafted policy text exists anywhere in this repository (
 * confirmed by a full-repository inventory before writing any page --
 * see docs/LEGAL_CONTENT_MAP.md). Every entry below is therefore
 * `status: 'draft'`, `source: 'internal_draft'` -- narrow, non-guaranteeing
 * text pending legal review, not an approved position. See
 * docs/LEGAL_CONTENT_MAP.md for the full outstanding-review list.
 */
export type LegalDocumentStatus = 'draft' | 'approved'
export type LegalDocumentSource = 'legalese' | 'internal_draft'

export interface LegalDocument {
  slug: string
  title: string
  version: string
  effectiveDate: string
  lastUpdated: string
  status: LegalDocumentStatus
  source: LegalDocumentSource
  route: string
  /** Which consent checkpoint(s) reference this document, for docs/traceability only. */
  consentContexts: Array<'registration' | 'booking_request' | 'checkout' | 'verification' | 'listing_submission'>
}

const DRAFT_DATE = '2026-08-06'

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    slug: 'terms',
    title: 'Terms of Use',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/terms',
    consentContexts: ['registration'],
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/privacy',
    consentContexts: ['registration', 'verification'],
  },
  {
    slug: 'popia',
    title: 'POPIA Notice',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/popia',
    consentContexts: ['registration', 'verification'],
  },
  {
    slug: 'rental-terms',
    title: 'Rental Terms',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/rental-terms',
    consentContexts: ['booking_request'],
  },
  {
    slug: 'payments-and-deposits',
    title: 'Payment and Deposit Policy',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/payments-and-deposits',
    consentContexts: ['checkout'],
  },
  {
    slug: 'cancellations',
    title: 'Cancellation Policy',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/cancellations',
    consentContexts: ['booking_request'],
  },
  {
    slug: 'refunds',
    title: 'Refund Policy',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/refunds',
    consentContexts: ['checkout'],
  },
  {
    slug: 'disputes',
    title: 'Dispute Resolution Policy',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/disputes',
    consentContexts: [],
  },
  {
    slug: 'prohibited-items',
    title: 'Prohibited Items Policy',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/prohibited-items',
    consentContexts: ['listing_submission'],
  },
  {
    slug: 'delivery-and-handover',
    title: 'Delivery and Handover Terms',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/delivery-and-handover',
    consentContexts: ['booking_request'],
  },
  {
    slug: 'verification-and-trust',
    title: 'Verification and Trust',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/verification-and-trust',
    consentContexts: ['verification'],
  },
  {
    slug: 'contact',
    title: 'Contact',
    version: '0.1',
    effectiveDate: DRAFT_DATE,
    lastUpdated: DRAFT_DATE,
    status: 'draft',
    source: 'internal_draft',
    route: '/contact',
    consentContexts: [],
  },
]

export function getLegalDocument(slug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((d) => d.slug === slug)
}

/** Resolves the current version for each requested slug -- unknown slugs are silently dropped, never invented. */
export function resolvePolicyVersions(slugs: string[]): Array<{ slug: string; version: string }> {
  return slugs
    .map((slug) => getLegalDocument(slug))
    .filter((d): d is LegalDocument => Boolean(d))
    .map((d) => ({ slug: d.slug, version: d.version }))
}
