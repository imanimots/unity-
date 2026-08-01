import { calculatePlatformFee } from './calculations'
import type { PaymentStatus } from './state-machine'

export type LedgerEntryType =
  | 'rental_charge'
  | 'deposit_hold'
  | 'deposit_release'
  | 'deposit_capture'
  | 'refund'
  | 'platform_fee'
  | 'merchant_payout'

export interface DerivedLedgerEntry {
  entryType: LedgerEntryType
  amount: number
}

/**
 * Mirrors transition_payment_status()'s ledger-writing branches exactly
 * (supabase/migrations/20260801000004_payment_rpcs.sql) -- which entries
 * a given payment-status transition produces. The RPC is what actually
 * writes them (atomically, alongside the status update and the
 * payment_events row); this function exists so that mapping is testable
 * in isolation and documented in one place, matching the same "mirror
 * the SQL, cross-verify, don't duplicate the write path" pattern used
 * for the booking price calculator.
 *
 * The ledger itself is append-only and immutable at the database layer
 * (no UPDATE/DELETE policy on ledger_entries for any role, RLS enabled
 * with zero client policies at all -- see
 * supabase/migrations/20260801000003_payment_security.sql). A mistaken
 * entry is corrected with an offsetting reversal entry referencing the
 * original via reversal_of, never edited or deleted.
 */
export function deriveLedgerEntries(
  paymentType: 'deposit' | 'rental_charge',
  newStatus: PaymentStatus,
  amount: number
): DerivedLedgerEntry[] {
  if (newStatus === 'captured' && paymentType === 'rental_charge') {
    return [
      { entryType: 'rental_charge', amount },
      { entryType: 'platform_fee', amount: calculatePlatformFee(amount) },
    ]
  }
  if (newStatus === 'authorised' && paymentType === 'deposit') {
    return [{ entryType: 'deposit_hold', amount }]
  }
  if (newStatus === 'released' && paymentType === 'deposit') {
    return [{ entryType: 'deposit_release', amount }]
  }
  if ((newStatus === 'captured' || newStatus === 'partially_captured') && paymentType === 'deposit') {
    return [{ entryType: 'deposit_capture', amount }]
  }
  return []
}
