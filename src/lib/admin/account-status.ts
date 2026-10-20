import { NextResponse } from 'next/server'
import type { AccountStatus, Profile } from '@/types'

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  active: 'Active',
  restricted: 'Restricted',
  suspended: 'Suspended',
  erased: 'Erased',
}

/**
 * Restricted behavior (per docs/ADMIN_OPERATIONS.md): may browse and view
 * existing records; cannot create new listings or bookings; existing
 * obligations remain visible and actionable. Suspended is stricter: cannot
 * create OR accept new transactions at all; protected routes remain
 * available only to resolve existing obligations. Erased (see
 * src/lib/privacy/account-erasure.ts) is terminal and at least as strict as
 * suspended on both gates -- there are no "existing obligations" left to
 * resolve, since erase_account() only ever completes once none remain.
 */
export function blocksCreation(status: AccountStatus): boolean {
  return status === 'restricted' || status === 'suspended' || status === 'erased'
}

export function blocksNewTransactions(status: AccountStatus): boolean {
  return status === 'suspended' || status === 'erased'
}

export function accountStatusErrorResponse(status: AccountStatus): NextResponse {
  const message =
    status === 'erased'
      ? 'This account has been erased and can no longer be used.'
      : status === 'suspended'
        ? 'Your account is suspended and cannot start new transactions. Contact support if you believe this is a mistake.'
        : 'Your account is restricted and cannot create new listings or bookings. Contact support if you believe this is a mistake.'
  return NextResponse.json({ error: message }, { status: 403 })
}

/** Gate for actions that create something new (a listing, a booking request). */
export function blockIfCannotCreate(profile: Pick<Profile, 'account_status'>): NextResponse | null {
  if (blocksCreation(profile.account_status)) {
    return accountStatusErrorResponse(profile.account_status)
  }
  return null
}

/** Gate for actions that begin a new transaction (accept, checkout, rental start, KYC submission). */
export function blockIfCannotTransact(profile: Pick<Profile, 'account_status'>): NextResponse | null {
  if (blocksNewTransactions(profile.account_status)) {
    return accountStatusErrorResponse(profile.account_status)
  }
  return null
}
