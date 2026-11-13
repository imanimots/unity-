import { describe, it, expect } from 'vitest'
import { parseRentalChargeResponse, parseRefundResponse, parseDepositResponse, parsePayoutResponse } from '../response-parsers'

describe('parseRentalChargeResponse', () => {
  it('maps a successful result code to captured', () => {
    const result = parseRentalChargeResponse({ id: 'txn_1', result: { code: '000.000.000' } })
    expect(result).toEqual({ providerReference: 'txn_1', status: 'captured' })
  })

  it('maps a declined result code to failed, carrying the description as the failure reason', () => {
    const result = parseRentalChargeResponse({ id: 'txn_1', result: { code: '800.100.151', description: 'invalid card' } })
    expect(result).toEqual({ providerReference: 'txn_1', status: 'failed', failureReason: 'invalid card' })
  })

  it('falls back to the raw code as the failure reason when no description is present', () => {
    const result = parseRentalChargeResponse({ id: 'txn_1', result: { code: '800.100.151' } })
    expect(result.status).toBe('failed')
    expect((result as { failureReason?: string }).failureReason).toBe('800.100.151')
  })
})

describe('parseRefundResponse', () => {
  it('maps a successful result code to completed', () => {
    expect(parseRefundResponse({ id: 'txn_1', result: { code: '000.000.000' } })).toEqual({ providerReference: 'txn_1', status: 'completed' })
  })

  it('maps an unsupported-refund-type code to failed', () => {
    const result = parseRefundResponse({ id: 'txn_1', result: { code: '700.300.100', description: 'cannot be refunded' } })
    expect(result).toEqual({ providerReference: 'txn_1', status: 'failed', failureReason: 'cannot be refunded' })
  })
})

describe('parseDepositResponse', () => {
  it('maps a successful PA response to authorised', () => {
    expect(parseDepositResponse({ id: 'txn_1', paymentType: 'PA', result: { code: '000.000.000' } })).toEqual({
      providerReference: 'txn_1',
      status: 'authorised',
    })
  })

  it('maps a successful CP response to captured', () => {
    expect(parseDepositResponse({ id: 'txn_1', paymentType: 'CP', result: { code: '000.000.000' } })).toEqual({
      providerReference: 'txn_1',
      status: 'captured',
    })
  })

  it('maps a successful RV response to released', () => {
    expect(parseDepositResponse({ id: 'txn_1', paymentType: 'RV', result: { code: '000.000.000' } })).toEqual({
      providerReference: 'txn_1',
      status: 'released',
    })
  })

  it('maps a failed response to failed regardless of paymentType', () => {
    const result = parseDepositResponse({ id: 'txn_1', paymentType: 'CP', result: { code: '700.300.100', description: 'invalid type' } })
    expect(result).toEqual({ providerReference: 'txn_1', status: 'failed', failureReason: 'invalid type' })
  })
})

describe('parsePayoutResponse', () => {
  // E33: MerchantPayoutResult.status was widened to the exact same
  // 6-value PayoutState union this function already received as input
  // (see provider.ts) -- this is now a direct pass-through, a strict
  // improvement over the previous lossy 3-state collapse (which this
  // test used to assert).
  it.each(['pending', 'processing', 'successful', 'failed', 'cancelled', 'reversed'] as const)('passes %s through unchanged, echoing payoutId as providerPayoutId', (status) => {
    expect(parsePayoutResponse({ payoutId: 'po_1', status })).toEqual({ providerPayoutId: 'po_1', status })
  })
})
