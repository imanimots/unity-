/** How long a pending commission sits before the automatic reconciliation sweep can finalize it as 'earned' -- long enough for a refund/dispute/chargeback to surface first. Mirrors AFFILIATE_COMMISSION_REVIEW_HOURS. */
export const UNITY_COMMISSION_REVIEW_HOURS = 48

/** Every internal sweep processes a bounded batch, never a full-table scan. */
export const UNITY_COMMISSION_SWEEP_BATCH_LIMIT = 100
