import { describe, it, expect } from 'vitest'
import { buildRentalChargeRequest, buildRefundRequest, buildCardCaptureOrReversalRequest, buildPayoutRequest } from '../request-builders'

const paymentsApiConfig = { baseUrl: 'https://testapi-v2.peachpayments.com', entityId: 'e1', userId: 'u1', password: 'p1' }

describe('buildRentalChargeRequest', () => {
  it('formats amount as a 2-decimal-place rand string and sets paymentType DB', () => {
    const request = buildRentalChargeRequest({
      config: paymentsApiConfig,
      merchantTransactionId: 'unity-b1-rental',
      amount: 1500,
      currency: 'ZAR',
      paymentBrand: 'VISA',
    })
    expect(request.amount).toBe('1500.00')
    expect(request.paymentType).toBe('DB')
    expect(request.authentication).toEqual({ entityId: 'e1', userId: 'u1', password: 'p1' })
  })

  it('preserves a fractional amount without rounding error', () => {
    const request = buildRentalChargeRequest({
      config: paymentsApiConfig,
      merchantTransactionId: 'unity-b1-rental',
      amount: 149.9,
      currency: 'ZAR',
      paymentBrand: 'VISA',
    })
    expect(request.amount).toBe('149.90')
  })

  it('omits shopperResultUrl when not provided, includes it when it is', () => {
    const without = buildRentalChargeRequest({ config: paymentsApiConfig, merchantTransactionId: 'x', amount: 100, currency: 'ZAR', paymentBrand: 'VISA' })
    expect('shopperResultUrl' in without).toBe(false)

    const withUrl = buildRentalChargeRequest({
      config: paymentsApiConfig,
      merchantTransactionId: 'x',
      amount: 100,
      currency: 'ZAR',
      paymentBrand: 'VISA',
      shopperResultUrl: 'https://unity.example/return',
    })
    expect(withUrl.shopperResultUrl).toBe('https://unity.example/return')
  })
})

describe('buildRefundRequest', () => {
  it('sets paymentType RF and formats the amount', () => {
    const request = buildRefundRequest({ config: paymentsApiConfig, amount: 250.5, currency: 'ZAR' })
    expect(request.paymentType).toBe('RF')
    expect(request.amount).toBe('250.50')
  })
})

describe('buildCardCaptureOrReversalRequest', () => {
  it('produces the CP body for a capture', () => {
    expect(buildCardCaptureOrReversalRequest('CP')).toEqual({ paymentType: 'CP' })
  })
  it('produces the RV body for a reversal', () => {
    expect(buildCardCaptureOrReversalRequest('RV')).toEqual({ paymentType: 'RV' })
  })
})

describe('buildPayoutRequest', () => {
  it('converts a rand amount to an integer number of cents -- the one place a unit-mismatch bug would be easy to introduce', () => {
    const request = buildPayoutRequest({
      payoutId: 'po_1',
      bankName: 'FIRSTNATIONALBANK',
      accountNumber: '123456789',
      branchCode: '250655',
      amountRand: 950,
      currency: 'ZAR',
      accountHolder: 'Merchant A',
      reference: 'unity-payout-1',
    })
    expect(request.payouts[0].amount).toBe(95000)
  })

  it('rounds fractional-cent rand amounts to the nearest cent', () => {
    const request = buildPayoutRequest({
      payoutId: 'po_1',
      bankName: 'FIRSTNATIONALBANK',
      accountNumber: '123456789',
      branchCode: '250655',
      amountRand: 149.995,
      currency: 'ZAR',
      accountHolder: 'Merchant A',
      reference: 'unity-payout-1',
    })
    expect(request.payouts[0].amount).toBe(15000)
  })

  it('wraps a single recipient in the payouts array, matching the documented single-recipient-per-call shape', () => {
    const request = buildPayoutRequest({
      payoutId: 'po_1',
      bankName: 'FIRSTNATIONALBANK',
      accountNumber: '123456789',
      branchCode: '250655',
      amountRand: 100,
      currency: 'ZAR',
      accountHolder: 'Merchant A',
      reference: 'unity-payout-1',
    })
    expect(request.payouts).toHaveLength(1)
    expect(request.payouts[0].payoutId).toBe('po_1')
  })
})
