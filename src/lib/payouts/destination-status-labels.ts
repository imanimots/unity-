/**
 * E34: status-badge classes for payout destination verification_status,
 * following this codebase's established per-domain Record<Status,
 * {classes}> idiom (src/lib/affiliate/status-labels.ts,
 * src/lib/payouts/status-labels.ts) rather than a shadcn Badge
 * component (none exists in this codebase). 'stale' is computed by the
 * caller (verification_expires_at < now()), never stored -- see E32's
 * own eligibility RPC, which computes it the same way server-side.
 */
export type PayoutDestinationDisplayStatus = 'unverified' | 'pending' | 'processing' | 'verified' | 'failed' | 'stale'

export const PAYOUT_DESTINATION_STATUS_CLASSES: Record<PayoutDestinationDisplayStatus, string> = {
  unverified: 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]',
  pending: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  processing: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  verified: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  failed: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  stale: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
}

export function computeDisplayStatus(verificationStatus: string, verificationExpiresAt: string | null): PayoutDestinationDisplayStatus {
  if (verificationStatus === 'verified' && verificationExpiresAt && new Date(verificationExpiresAt) < new Date()) {
    return 'stale'
  }
  if (verificationStatus === 'unverified' || verificationStatus === 'pending' || verificationStatus === 'processing' || verificationStatus === 'verified' || verificationStatus === 'failed') {
    return verificationStatus
  }
  return 'unverified'
}

/** Within this many days of expiry, show an "expiring soon" warning -- a UI display threshold only, never the freshness AUTHORITY itself (verification_expires_at, set server-side by E32). */
export const EXPIRY_WARNING_WINDOW_DAYS = 14

export function isExpiringSoon(verificationStatus: string, verificationExpiresAt: string | null): boolean {
  if (verificationStatus !== 'verified' || !verificationExpiresAt) return false
  const expires = new Date(verificationExpiresAt)
  const warnFrom = new Date(expires.getTime() - EXPIRY_WARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  return new Date() >= warnFrom && new Date() < expires
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  current_cheque_account: 'Current / Cheque account',
  savings_account: 'Savings account',
  transmission_account: 'Transmission account',
  bond_account: 'Bond account',
  subscription_share: 'Subscription share account',
  unknown: 'Other',
}

export function accountTypeLabel(accountType: string): string {
  return ACCOUNT_TYPE_LABELS[accountType] ?? accountType
}

export const ACCOUNT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'current_cheque_account', label: ACCOUNT_TYPE_LABELS.current_cheque_account },
  { value: 'savings_account', label: ACCOUNT_TYPE_LABELS.savings_account },
  { value: 'transmission_account', label: ACCOUNT_TYPE_LABELS.transmission_account },
  { value: 'bond_account', label: ACCOUNT_TYPE_LABELS.bond_account },
  { value: 'subscription_share', label: ACCOUNT_TYPE_LABELS.subscription_share },
]
