import { describe, it, expect, vi } from 'vitest'
import { getPeachPayoutActivationReadiness, isProductionReady } from '../activation-readiness'

function fakeAdmin(options: { destinationHealthError?: unknown } = {}) {
  const from = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ error: options.destinationHealthError ?? null }),
  }))
  return { from } as never
}

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'key',
} as unknown as NodeJS.ProcessEnv

describe('getPeachPayoutActivationReadiness', () => {
  it('1. reports every gate closed when nothing is configured', async () => {
    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), BASE_ENV)

    expect(readiness.executionGateConfigured).toBe(false)
    expect(readiness.credentialsPresent).toBe(false)
    expect(readiness.productActivationConfirmed).toBe('unknown')
    expect(readiness.sourceOfFundsConfirmed).toBe('unknown')
    expect(readiness.webhookConfigured).toBe('no')
    expect(readiness.webhookSigningConfigured).toBe(false)
    expect(readiness.sandboxCertified).toBe(false)
    expect(readiness.sandboxCertificationBlockedReason).toBe('SANDBOX CREDENTIALS NOT AVAILABLE')
    expect(readiness.productionCanaryApproved).toBe(false)
  })

  it('2. credentials existing does NOT prove product activation or source-of-funds approval -- both stay unknown', async () => {
    const env = {
      ...BASE_ENV,
      PEACH_PAYOUTS_CLIENT_ID: 'id',
      PEACH_PAYOUTS_CLIENT_SECRET: 'secret',
      PEACH_PAYOUTS_MERCHANT_ID: 'merchant-1',
      PEACH_ENVIRONMENT: 'sandbox',
    } as unknown as NodeJS.ProcessEnv

    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), env)

    expect(readiness.credentialsPresent).toBe(true)
    expect(readiness.productActivationConfirmed).toBe('unknown')
    expect(readiness.sourceOfFundsConfirmed).toBe('unknown')
  })

  it('3. reports partially-set credentials as NOT present (loadPeachPayoutsConfig throws), never crashing the readiness check itself', async () => {
    const env = { ...BASE_ENV, PEACH_PAYOUTS_CLIENT_ID: 'id' } as unknown as NodeJS.ProcessEnv

    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), env)

    expect(readiness.credentialsPresent).toBe(false)
    expect(readiness.providerClientHealthy).toBe(false)
  })

  it('4. product activation and source-of-funds read only the exact string "true"/"false", never inferred', async () => {
    const env = { ...BASE_ENV, PEACH_PAYOUTS_PRODUCT_ACTIVE: 'yes', PEACH_SOURCE_OF_FUNDS_APPROVED: '1' } as unknown as NodeJS.ProcessEnv

    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), env)

    expect(readiness.productActivationConfirmed).toBe('unknown')
    expect(readiness.sourceOfFundsConfirmed).toBe('unknown')
  })

  it('5. explicit "true"/"false" attestation values are read through exactly', async () => {
    const env = { ...BASE_ENV, PEACH_PAYOUTS_PRODUCT_ACTIVE: 'true', PEACH_SOURCE_OF_FUNDS_APPROVED: 'false' } as unknown as NodeJS.ProcessEnv

    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), env)

    expect(readiness.productActivationConfirmed).toBe('yes')
    expect(readiness.sourceOfFundsConfirmed).toBe('no')
  })

  it('6. webhookConfigured is "unknown" (never "yes") even with a signing secret present -- Dashboard-only config can never be verified by code', async () => {
    const env = { ...BASE_ENV, PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET: 'whsec_abc' } as unknown as NodeJS.ProcessEnv

    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), env)

    expect(readiness.webhookSigningConfigured).toBe(true)
    expect(readiness.webhookConfigured).toBe('unknown')
  })

  it('7. destinationAuthorityHealthy reflects a failed DB health check', async () => {
    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin({ destinationHealthError: { message: 'relation does not exist' } }), BASE_ENV)
    expect(readiness.destinationAuthorityHealthy).toBe(false)
  })

  it('8. sandboxCertified is always false -- never self-reported true by this function', async () => {
    const env = {
      ...BASE_ENV,
      PEACH_PAYOUTS_CLIENT_ID: 'id',
      PEACH_PAYOUTS_CLIENT_SECRET: 'secret',
      PEACH_PAYOUTS_MERCHANT_ID: 'merchant-1',
      PEACH_ENVIRONMENT: 'sandbox',
    } as unknown as NodeJS.ProcessEnv
    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), env)
    expect(readiness.sandboxCertified).toBe(false)
  })

  it('9. productionCanaryApproved is always false -- no mechanism exists to flip it', async () => {
    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), BASE_ENV)
    expect(readiness.productionCanaryApproved).toBe(false)
  })
})

describe('isProductionReady', () => {
  it('10. false when every gate is closed', async () => {
    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), BASE_ENV)
    expect(isProductionReady(readiness)).toBe(false)
  })

  it('11. CRITICAL: false even when every checkable gate passes, because sandboxCertified can never become true via this function', async () => {
    const env = {
      ...BASE_ENV,
      PEACH_PAYOUTS_EXECUTION_ENABLED: 'true',
      PEACH_PAYOUTS_CLIENT_ID: 'id',
      PEACH_PAYOUTS_CLIENT_SECRET: 'secret',
      PEACH_PAYOUTS_MERCHANT_ID: 'merchant-1',
      PEACH_ENVIRONMENT: 'production',
      PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET: 'whsec_abc',
      PEACH_PAYOUTS_PRODUCT_ACTIVE: 'true',
      PEACH_SOURCE_OF_FUNDS_APPROVED: 'true',
    } as unknown as NodeJS.ProcessEnv

    const readiness = await getPeachPayoutActivationReadiness(fakeAdmin(), env)
    expect(isProductionReady(readiness)).toBe(false)
  })
})
