/**
 * Canonical journey microcopy for recurring concepts, used by
 * ContextualHelp triggers across the app. One wording per concept here,
 * never re-drafted independently at each render site (see the customer-
 * journey mapping's PHASE 32 / duplication-audit rule). Each entry's
 * `learnMoreHref` must be a real /help/[slug] route -- see
 * src/lib/help/__tests__/registries.test.ts and
 * src/lib/help/__tests__/contextual-copy.test.ts for the checks that
 * keep both constraints honest.
 *
 * This is intentionally a flat object, not a class or a fetched config --
 * the set of concepts is small, known at build time, and the whole point
 * is to make drift impossible to introduce by accident, not to build
 * infrastructure for a problem this size doesn't have.
 */

export interface ContextualCopyEntry {
  label: string
  text: string
  learnMoreHref: string
}

export const CONTEXTUAL_COPY = {
  verification: {
    label: 'What does verification mean?',
    text: "Verification confirms identity. It doesn't guarantee honesty, item condition, or a successful transaction.",
    learnMoreHref: '/help/what-verification-means',
  },
  ownershipVerification: {
    label: 'What does ownership verification mean?',
    text: "This checks the merchant's proof that they own this specific item -- a separate, per-listing fact from their own identity verification.",
    learnMoreHref: '/help/what-verification-means',
  },
  sponsoredListing: {
    label: 'What does Sponsored mean?',
    text: 'Sponsored listings are paid placements. They do not affect reviews or verification, and never override organic ranking for everyone else.',
    learnMoreHref: '/help/search-ranking-and-promoted-listings',
  },
  unityScore: {
    label: 'What is Unity Score?',
    text: "A 0-5 score reflecting the average rating of reviews this person has received. New accounts start at 5.00.",
    learnMoreHref: '/help/unity-glossary',
  },
  riskTier: {
    label: 'What is a risk tier?',
    text: "Unity assigns this automatically from the item's value, category, and the merchant's standing -- it can require a deposit, insurance, or ownership verification. It can't be set manually.",
    learnMoreHref: '/help/unity-glossary',
  },
  rentalDeposit: {
    label: 'What is this deposit for?',
    text: 'Refunded once the item is confirmed returned in good condition.',
    learnMoreHref: '/help/how-payments-work-on-unity',
  },
  platformFee: {
    label: 'What is this fee?',
    text: "Unity's service fee for this transaction.",
    learnMoreHref: '/help/fees-and-commissions-explained',
  },
  marketplaceRequest: {
    label: 'What is a Marketplace Request?',
    text: 'Post what you need instead of searching for it -- sellers and merchants can respond with offers.',
    learnMoreHref: '/help/how-marketplace-requests-work',
  },
  rtbModeNote: {
    label: 'Where is Rent-to-Buy?',
    text: 'Rent-to-Buy listings appear under Rent -- it\'s a feature of renting, not a separate mode.',
    learnMoreHref: '/help/buy-rent-barter-and-rent-to-buy-explained',
  },
  rtbPossessionOwnership: {
    label: 'Do I own it once I start paying?',
    text: 'Possession and ownership are separate. Review the full terms before requesting.',
    learnMoreHref: '/help/buy-rent-barter-and-rent-to-buy-explained',
  },
  skillVsTask: {
    label: 'Skill vs. Task?',
    text: "Skill = something you can personally do or provide. Task = a specific, one-off job you need someone else to complete.",
    learnMoreHref: '/help/buy-rent-barter-and-rent-to-buy-explained',
  },
  disputeEvidence: {
    label: 'What evidence helps?',
    text: 'Photos or documents from before and after handover, together with relevant messages, are usually the most useful evidence.',
    learnMoreHref: '/help/cancellations-refunds-and-disputes',
  },
  sortRelevance: {
    label: 'How is Relevance ranked?',
    text: 'An exact title match ranks first, then a keyword match, then a close-but-not-exact match -- see how search works for the full explanation.',
    learnMoreHref: '/help/how-unity-search-works',
  },
} as const satisfies Record<string, ContextualCopyEntry>

export type ContextualCopyKey = keyof typeof CONTEXTUAL_COPY

/** Messaging safety banner -- persistent at thread level, never per-message. */
export const MESSAGING_SAFETY_NOTICE = {
  text: "Unity will never ask for your password or a one-time code. Keep payment and contact details on-platform.",
  learnMoreHref: '/help/how-to-recognise-a-scam',
}

/** Account restriction/suspension banner, shown in the dashboard shell. */
export const ACCOUNT_STATUS_NOTICE: Record<'restricted' | 'suspended', { text: string; learnMoreHref: string }> = {
  restricted: {
    text: 'Your account is currently restricted. You can\'t create new listings or bookings until this is resolved. Contact support if you believe this is a mistake.',
    learnMoreHref: '/help/marketplace-rules-and-prohibited-behaviour',
  },
  suspended: {
    text: 'Your account is currently suspended. You can\'t start new transactions until this is resolved — existing obligations remain visible and actionable. Contact support if you believe this is a mistake.',
    learnMoreHref: '/help/marketplace-rules-and-prohibited-behaviour',
  },
}
