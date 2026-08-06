/** How long a pending commission sits before automatic review can approve it -- long enough for a refund/dispute/chargeback to surface first. */
export const AFFILIATE_COMMISSION_REVIEW_HOURS = 48

/** Every internal sweep processes a bounded batch, never a full-table scan. */
export const AFFILIATE_SWEEP_BATCH_LIMIT = 100
