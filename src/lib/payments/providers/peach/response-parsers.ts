import type { ChargeResult, RefundResult, DepositResult, MerchantPayoutResult } from '../../provider'
import { isPeachSuccessResultCode } from './error-mapper'

/**
 * Pure response parsers -- given a Peach JSON response body (already
 * fetched and JSON-parsed by the caller; no network code here), produce
 * Unity's own result shapes from ../../provider.ts. Mirrors
 * request-builders.ts: proves the *shape* of the translation without
 * performing the HTTP call that would actually move money.
 */

interface PeachPaymentsApiResponse {
  id: string
  result: { code: string; description?: string }
}

export function parseRentalChargeResponse(raw: PeachPaymentsApiResponse): ChargeResult {
  const success = isPeachSuccessResultCode(raw.result.code)
  return success
    ? { providerReference: raw.id, status: 'captured' }
    : { providerReference: raw.id, status: 'failed', failureReason: raw.result.description ?? raw.result.code }
}

export function parseRefundResponse(raw: PeachPaymentsApiResponse): RefundResult {
  const success = isPeachSuccessResultCode(raw.result.code)
  return success
    ? { providerReference: raw.id, status: 'completed' }
    : { providerReference: raw.id, status: 'failed', failureReason: raw.result.description ?? raw.result.code }
}

interface PeachCardApiResponse {
  id: string
  paymentType: 'PA' | 'CP' | 'RV'
  result: { code: string; description?: string }
}

/** Covers all three deposit-lifecycle responses (PA/CP/RV) -- the target status depends on which paymentType was sent, not just the result code. */
export function parseDepositResponse(raw: PeachCardApiResponse): DepositResult {
  const success = isPeachSuccessResultCode(raw.result.code)
  if (!success) {
    return { providerReference: raw.id, status: 'failed', failureReason: raw.result.description ?? raw.result.code }
  }
  const status = raw.paymentType === 'PA' ? 'authorised' : raw.paymentType === 'CP' ? 'captured' : 'released'
  return { providerReference: raw.id, status }
}

interface PeachPayoutResponse {
  payoutId: string
  status: 'pending' | 'processing' | 'failed' | 'successful' | 'cancelled' | 'reversed'
}

/** docs/reference/querypayoutrequest -- PayoutState enum: pending/processing/failed/successful/cancelled/reversed. */
export function parsePayoutResponse(raw: PeachPayoutResponse): MerchantPayoutResult {
  if (raw.status === 'successful') return { providerReference: raw.payoutId, status: 'paid' }
  if (raw.status === 'pending' || raw.status === 'processing') return { providerReference: raw.payoutId, status: 'pending' }
  return { providerReference: raw.payoutId, status: 'failed' }
}
