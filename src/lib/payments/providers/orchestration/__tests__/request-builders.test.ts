import { describe, it, expect } from 'vitest'
import { buildOrdinaryPaymentRequest, buildDepositAuthorisationRequest, buildHostedCheckoutPaymentRequest } from '../request-builders'

describe('buildOrdinaryPaymentRequest', () => {
  it('builds an automatic-capture request with the confirmed field set', () => {
    const req = buildOrdinaryPaymentRequest({ amount: '92.00', currency: 'ZAR', returnUrl: 'https://unity.example/checkout/return' })
    expect(req).toEqual({
      amount: 9200,
      currency: 'ZAR',
      confirm: false,
      payment_link: true,
      capture_method: 'automatic',
      return_url: 'https://unity.example/checkout/return',
    })
  })

  it('does not set allowed_payment_method_types -- business-profile-enabled methods only', () => {
    const req = buildOrdinaryPaymentRequest({ amount: '10.00', currency: 'ZAR', returnUrl: 'https://unity.example/checkout/return' })
    expect(req.allowed_payment_method_types).toBeUndefined()
  })

  it('includes metadata when supplied', () => {
    const req = buildOrdinaryPaymentRequest({
      amount: '10.00',
      currency: 'ZAR',
      returnUrl: 'https://unity.example/checkout/return',
      metadata: { unity_payment_id: 'abc-123' },
    })
    expect(req.metadata).toEqual({ unity_payment_id: 'abc-123' })
  })
})

describe('buildDepositAuthorisationRequest', () => {
  it('builds a manual-capture (preauthorisation) request', () => {
    const req = buildDepositAuthorisationRequest({ amount: '500.00', currency: 'ZAR', returnUrl: 'https://unity.example/checkout/return' })
    expect(req.capture_method).toBe('manual')
    expect(req.amount).toBe(50000)
    expect(req.confirm).toBe(false)
    expect(req.payment_link).toBe(true)
  })

  it('does not restrict payment methods -- preauthorisation-capable method set was not confirmed by documentation, so none is guessed', () => {
    const req = buildDepositAuthorisationRequest({ amount: '500.00', currency: 'ZAR', returnUrl: 'https://unity.example/checkout/return' })
    expect(req.allowed_payment_method_types).toBeUndefined()
  })
})

describe('buildHostedCheckoutPaymentRequest', () => {
  it('sets allowed_payment_method_types only when a non-empty list is supplied', () => {
    const withMethods = buildHostedCheckoutPaymentRequest({
      amount: '10.00',
      currency: 'ZAR',
      captureMethod: 'automatic',
      returnUrl: 'https://unity.example/checkout/return',
      allowedPaymentMethodTypes: ['CARD'],
    })
    expect(withMethods.allowed_payment_method_types).toEqual(['CARD'])

    const withoutMethods = buildHostedCheckoutPaymentRequest({
      amount: '10.00',
      currency: 'ZAR',
      captureMethod: 'automatic',
      returnUrl: 'https://unity.example/checkout/return',
      allowedPaymentMethodTypes: [],
    })
    expect(withoutMethods.allowed_payment_method_types).toBeUndefined()
  })
})
