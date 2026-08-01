import { describe, it, expect } from 'vitest'
import { loadPeachConfig, describePeachConfigStatus, PeachConfigurationError } from '../config'

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv
}

describe('loadPeachConfig', () => {
  it('throws PeachConfigurationError when PEACH_ENVIRONMENT is missing', () => {
    expect(() => loadPeachConfig(env({}))).toThrow(PeachConfigurationError)
  })

  it('throws PeachConfigurationError when PEACH_ENVIRONMENT is not sandbox/production', () => {
    expect(() => loadPeachConfig(env({ PEACH_ENVIRONMENT: 'staging' }))).toThrow(/sandbox.*production/)
  })

  it('returns every credential block as null when only PEACH_ENVIRONMENT is set', () => {
    const config = loadPeachConfig(env({ PEACH_ENVIRONMENT: 'sandbox' }))
    expect(config.paymentsApi).toBeNull()
    expect(config.checkout).toBeNull()
    expect(config.cardApi).toBeNull()
    expect(config.payouts).toBeNull()
  })

  it('resolves sandbox hosts when environment is sandbox', () => {
    const config = loadPeachConfig(
      env({
        PEACH_ENVIRONMENT: 'sandbox',
        PEACH_PAYMENTS_API_ENTITY_ID: 'e1',
        PEACH_PAYMENTS_API_USER_ID: 'u1',
        PEACH_PAYMENTS_API_PASSWORD: 'p1',
      })
    )
    expect(config.paymentsApi?.baseUrl).toBe('https://testapi-v2.peachpayments.com')
  })

  it('resolves production hosts when environment is production', () => {
    const config = loadPeachConfig(
      env({
        PEACH_ENVIRONMENT: 'production',
        PEACH_PAYMENTS_API_ENTITY_ID: 'e1',
        PEACH_PAYMENTS_API_USER_ID: 'u1',
        PEACH_PAYMENTS_API_PASSWORD: 'p1',
      })
    )
    expect(config.paymentsApi?.baseUrl).toBe('https://api-v2.peachpayments.com')
  })

  it('only populates a credential block once every one of its variables is present', () => {
    const config = loadPeachConfig(
      env({
        PEACH_ENVIRONMENT: 'sandbox',
        PEACH_PAYMENTS_API_ENTITY_ID: 'e1',
        PEACH_PAYMENTS_API_USER_ID: 'u1',
        // password intentionally missing
      })
    )
    expect(config.paymentsApi).toBeNull()
  })

  it('populates checkout config including the webhook URL', () => {
    const config = loadPeachConfig(
      env({
        PEACH_ENVIRONMENT: 'sandbox',
        PEACH_CHECKOUT_ENTITY_ID: 'e1',
        PEACH_CHECKOUT_WEBHOOK_SIGNING_SECRET: 'secret',
        PEACH_CHECKOUT_WEBHOOK_URL: 'https://unity.example/api/payments/webhooks/peach',
      })
    )
    expect(config.checkout).toEqual({
      baseUrl: 'https://testsecure.peachpayments.com',
      entityId: 'e1',
      webhookSigningSecret: 'secret',
      webhookUrl: 'https://unity.example/api/payments/webhooks/peach',
    })
  })

  it('independently configured blocks do not depend on each other', () => {
    const config = loadPeachConfig(
      env({
        PEACH_ENVIRONMENT: 'sandbox',
        PEACH_PAYOUTS_API_BEARER_TOKEN: 'tok',
      })
    )
    expect(config.payouts).not.toBeNull()
    expect(config.paymentsApi).toBeNull()
    expect(config.checkout).toBeNull()
    expect(config.cardApi).toBeNull()
  })
})

describe('describePeachConfigStatus', () => {
  it('is unhealthy when no credential block is configured', () => {
    const config = loadPeachConfig(env({ PEACH_ENVIRONMENT: 'sandbox' }))
    expect(describePeachConfigStatus(config).healthy).toBe(false)
  })

  it('is healthy when at least one credential block is configured, and lists which', () => {
    const config = loadPeachConfig(
      env({
        PEACH_ENVIRONMENT: 'sandbox',
        PEACH_PAYOUTS_API_BEARER_TOKEN: 'tok',
      })
    )
    const status = describePeachConfigStatus(config)
    expect(status.healthy).toBe(true)
    expect(status.detail).toContain('payouts')
  })
})
