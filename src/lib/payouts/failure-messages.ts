import type { PayoutFailureCategory } from './status-labels'

/**
 * TS mirror of mark_payout_failed()'s own server-side mapping
 * (supabase/migrations/20260820000003_merchant_payout_rpcs.sql) --
 * the SQL version is authoritative for what actually gets stored in
 * failure_message_safe; this copy exists for the admin UI (to preview
 * the merchant-facing message before submitting) and for unit tests.
 * Kept in sync by hand, same convention as every idempotency hash
 * formula duplicated between TS and SQL elsewhere in this codebase.
 *
 * The admin's own free-text reason is never used here -- it is stored
 * only in merchant_payout_history.reason (admin-visible, never
 * merchant-facing).
 */
export const PAYOUT_FAILURE_SAFE_MESSAGES: Record<PayoutFailureCategory, string> = {
  recipient_details_unavailable: 'Unity does not yet have the information required to complete this payout.',
  recipient_details_invalid: 'The payout details on file could not be used. Unity will review and update them.',
  provider_unavailable: 'Payout processing is temporarily unavailable.',
  provider_declined: 'This payout could not be completed and is being reviewed.',
  compliance_review: 'This payout is under compliance review before it can continue.',
  account_restricted: 'This payout requires account review before it can continue.',
  source_payment_issue: 'The source rental payment requires review before payout can continue.',
  internal_consistency_error: 'Unity is reviewing an internal payout issue.',
  other: 'This payout could not be completed. Unity will review it.',
}

export function safeFailureMessageFor(category: PayoutFailureCategory): string {
  return PAYOUT_FAILURE_SAFE_MESSAGES[category]
}
