import { describe, it, expect } from 'vitest'
import { loadPeachPayoutsConfig } from '../payouts-config'
import { PeachConfigurationError } from '../config'

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv
}

describe('loadPeachPayoutsConfig', () => {
  it('1. returns null when nothing is configured', () => {
    expect(loadPeachPayoutsConfig(env({}))).toBeNull()
  })

  it('2. throws when only some of the client-credentials triple is set', () => {
    expect(() => loadPeachPayoutsConfig(env({ PEACH_PAYOUTS_CLIENT_ID: 'id' }))).toThrow(PeachConfigurationError)
    expect(() => loadPeachPayoutsConfig(env({ PEACH_PAYOUTS_CLIENT_ID: 'id', PEACH_PAYOUTS_CLIENT_SECRET: 'secret' }))).toThrow(PeachConfigurationError)
  })

  it('3. throws when PEACH_ENVIRONMENT is absent even though the credential triple is complete', () => {
    expect(() =>
      loadPeachPayoutsConfig(env({ PEACH_PAYOUTS_CLIENT_ID: 'id', PEACH_PAYOUTS_CLIENT_SECRET: 'secret', PEACH_PAYOUTS_MERCHANT_ID: 'merchant' }))
    ).toThrow(/PEACH_ENVIRONMENT/)
  })

  it('4. resolves the sandbox payouts host when PEACH_ENVIRONMENT=sandbox', () => {
    const config = loadPeachPayoutsConfig(
      env({ PEACH_PAYOUTS_CLIENT_ID: 'id', PEACH_PAYOUTS_CLIENT_SECRET: 'secret', PEACH_PAYOUTS_MERCHANT_ID: 'merchant', PEACH_ENVIRONMENT: 'sandbox' })
    )
    expect(config?.baseUrl).toBe('https://sandbox-payouts.peachpayments.com/api')
  })

  it('5. resolves the production payouts host when PEACH_ENVIRONMENT=production', () => {
    const config = loadPeachPayoutsConfig(
      env({ PEACH_PAYOUTS_CLIENT_ID: 'id', PEACH_PAYOUTS_CLIENT_SECRET: 'secret', PEACH_PAYOUTS_MERCHANT_ID: 'merchant', PEACH_ENVIRONMENT: 'production' })
    )
    expect(config?.baseUrl).toBe('https://payouts.peachpayments.com/api')
  })

  it('6. webhookSigningSecret is independently optional -- absent returns null, not an error', () => {
    const config = loadPeachPayoutsConfig(
      env({ PEACH_PAYOUTS_CLIENT_ID: 'id', PEACH_PAYOUTS_CLIENT_SECRET: 'secret', PEACH_PAYOUTS_MERCHANT_ID: 'merchant', PEACH_ENVIRONMENT: 'sandbox' })
    )
    expect(config?.webhookSigningSecret).toBeNull()
  })

  it('7. carries the webhook signing secret through when set', () => {
    const config = loadPeachPayoutsConfig(
      env({
        PEACH_PAYOUTS_CLIENT_ID: 'id',
        PEACH_PAYOUTS_CLIENT_SECRET: 'secret',
        PEACH_PAYOUTS_MERCHANT_ID: 'merchant',
        PEACH_ENVIRONMENT: 'sandbox',
        PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET: 'whsec_abc123',
      })
    )
    expect(config?.webhookSigningSecret).toBe('whsec_abc123')
  })
})
