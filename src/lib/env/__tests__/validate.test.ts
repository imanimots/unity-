import { describe, it, expect } from 'vitest'
import { validateEnvironment, formatEnvReport } from '../validate'

const VALID_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  NEXT_PUBLIC_APP_URL: 'https://unity-test.vercel.app',
  NEXT_PUBLIC_MOCK_MODE: 'false',
  PAYMENT_PROVIDER: 'mock',
  OWNERSHIP_VERIFICATION_PROVIDER: 'manual',
  IDENTITY_VERIFICATION_PROVIDER: 'manual',
  EMAIL_PROVIDER: 'console',
  NEXT_PUBLIC_PAYMENT_MODE: 'test',
  INTERNAL_CRON_SECRET: 'secret',
} as unknown as NodeJS.ProcessEnv

describe('environment validator (category: Environment Validation)', () => {
  it('1. passes with a fully valid environment', () => {
    const report = validateEnvironment(VALID_ENV)
    expect(report.ok).toBe(true)
    expect(report.criticalFailures).toEqual([])
  })

  it('2. fails when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
    const env = { ...VALID_ENV, SUPABASE_SERVICE_ROLE_KEY: undefined }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('3. fails when PAYMENT_PROVIDER is set to a value outside mock/peach (E38: peach is now a supported value, see the dedicated describe block below)', () => {
    const env = { ...VALID_ENV, PAYMENT_PROVIDER: 'payfast' }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('PAYMENT_PROVIDER')
  })

  it('4. fails when OWNERSHIP_VERIFICATION_PROVIDER is set to sumsub (not yet integrated)', () => {
    const env = { ...VALID_ENV, OWNERSHIP_VERIFICATION_PROVIDER: 'sumsub' }
    const report = validateEnvironment(env)
    expect(report.criticalFailures).toContain('OWNERSHIP_VERIFICATION_PROVIDER')
  })

  it('5. Peach/Sumsub credentials being ABSENT never fails validation', () => {
    const env = { ...VALID_ENV }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(true)
  })

  it('6. NEXT_PUBLIC_MOCK_MODE defaults to "false" when unset, and that is valid', () => {
    const env = { ...VALID_ENV, NEXT_PUBLIC_MOCK_MODE: undefined }
    const report = validateEnvironment(env)
    const mockModeCheck = report.checks.find((c) => c.name === 'NEXT_PUBLIC_MOCK_MODE')
    expect(mockModeCheck?.status).toBe('ok')
  })

  it('7. optional vars (ANTHROPIC_API_KEY etc.) being unset never fails validation', () => {
    const report = validateEnvironment(VALID_ENV)
    const anthropicCheck = report.checks.find((c) => c.name === 'ANTHROPIC_API_KEY')
    expect(anthropicCheck?.required).toBe(false)
    expect(report.ok).toBe(true)
  })

  it('8. the formatted report never contains a real value, only names/statuses', () => {
    const env = { ...VALID_ENV, SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value-should-never-appear' }
    const report = validateEnvironment(env)
    const text = formatEnvReport(report)
    expect(text).not.toContain('super-secret-value-should-never-appear')
    expect(text).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('9. INTERNAL_CRON_SECRET missing is a critical failure (crons are closed by default otherwise)', () => {
    const env = { ...VALID_ENV, INTERNAL_CRON_SECRET: undefined }
    const report = validateEnvironment(env)
    expect(report.criticalFailures).toContain('INTERNAL_CRON_SECRET')
  })

  it('10. NODE_ENV=production + ESCROW_ENABLED=true + ESCROW_PROVIDER=mock is a critical failure -- defense in depth alongside getEscrowProvider()\'s own unconditional runtime guard', () => {
    const env = { ...VALID_ENV, NODE_ENV: 'production', ESCROW_ENABLED: 'true', ESCROW_PROVIDER: 'mock' } as unknown as NodeJS.ProcessEnv
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('ESCROW_PROVIDER')
  })

  it('11. NODE_ENV=production + ESCROW_ENABLED=true + ESCROW_PROVIDER unset (defaults to mock) is also a critical failure', () => {
    const env = { ...VALID_ENV, NODE_ENV: 'production', ESCROW_ENABLED: 'true', ESCROW_PROVIDER: undefined } as unknown as NodeJS.ProcessEnv
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('ESCROW_PROVIDER')
  })

  it('12. NODE_ENV=production + ESCROW_ENABLED unset (disabled) never fails, even with ESCROW_PROVIDER=mock configured', () => {
    const env = { ...VALID_ENV, NODE_ENV: 'production', ESCROW_ENABLED: undefined, ESCROW_PROVIDER: 'mock' } as unknown as NodeJS.ProcessEnv
    const report = validateEnvironment(env)
    expect(report.ok).toBe(true)
  })

  it('13. NODE_ENV=production + ESCROW_ENABLED=false never fails, even with ESCROW_PROVIDER=mock configured', () => {
    const env = { ...VALID_ENV, NODE_ENV: 'production', ESCROW_ENABLED: 'false', ESCROW_PROVIDER: 'mock' } as unknown as NodeJS.ProcessEnv
    const report = validateEnvironment(env)
    expect(report.ok).toBe(true)
  })

  it('14. NODE_ENV=development + ESCROW_ENABLED=true + ESCROW_PROVIDER=mock never fails', () => {
    const env = { ...VALID_ENV, NODE_ENV: 'development', ESCROW_ENABLED: 'true', ESCROW_PROVIDER: 'mock' } as unknown as NodeJS.ProcessEnv
    const report = validateEnvironment(env)
    expect(report.ok).toBe(true)
  })
})

const VALID_PEACH_ENV = {
  ...VALID_ENV,
  PAYMENT_PROVIDER: 'peach',
  PEACH_PAYOUTS_CLIENT_ID: 'client-id',
  PEACH_PAYOUTS_CLIENT_SECRET: 'client-secret',
  PEACH_PAYOUTS_MERCHANT_ID: 'merchant-id',
  PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET: 'webhook-secret',
  PEACH_ENVIRONMENT: 'production',
} as unknown as NodeJS.ProcessEnv

describe('PAYMENT_PROVIDER=peach -- Public-Test to Peach-capable production transition (E38)', () => {
  it('1. PAYMENT_PROVIDER=mock passes without any Peach payout variables set', () => {
    const report = validateEnvironment(VALID_ENV)
    expect(report.ok).toBe(true)
  })

  it('2. PAYMENT_PROVIDER=peach with all four credentials present and PEACH_ENVIRONMENT=production passes', () => {
    const report = validateEnvironment(VALID_PEACH_ENV)
    expect(report.ok).toBe(true)
    expect(report.criticalFailures).toEqual([])
  })

  it('3. PAYMENT_PROVIDER=peach with PEACH_PAYOUTS_CLIENT_ID missing fails closed', () => {
    const env = { ...VALID_PEACH_ENV, PEACH_PAYOUTS_CLIENT_ID: undefined }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('PEACH_PAYOUTS_CLIENT_ID')
  })

  it('4. PAYMENT_PROVIDER=peach with PEACH_PAYOUTS_CLIENT_SECRET missing fails closed', () => {
    const env = { ...VALID_PEACH_ENV, PEACH_PAYOUTS_CLIENT_SECRET: undefined }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('PEACH_PAYOUTS_CLIENT_SECRET')
  })

  it('5. PAYMENT_PROVIDER=peach with PEACH_PAYOUTS_MERCHANT_ID missing fails closed', () => {
    const env = { ...VALID_PEACH_ENV, PEACH_PAYOUTS_MERCHANT_ID: undefined }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('PEACH_PAYOUTS_MERCHANT_ID')
  })

  it('6. PAYMENT_PROVIDER=peach with PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET missing fails closed', () => {
    const env = { ...VALID_PEACH_ENV, PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET: undefined }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET')
  })

  it('7. PAYMENT_PROVIDER=peach with PEACH_ENVIRONMENT missing fails closed', () => {
    const env = { ...VALID_PEACH_ENV, PEACH_ENVIRONMENT: undefined }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('PEACH_ENVIRONMENT')
  })

  it('8. PAYMENT_PROVIDER=peach with PEACH_ENVIRONMENT=sandbox fails closed -- a missing value never silently falls back to sandbox, and sandbox itself is rejected at this app-provider-selector level', () => {
    const env = { ...VALID_PEACH_ENV, PEACH_ENVIRONMENT: 'sandbox' }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('PEACH_ENVIRONMENT')
  })

  it('9. PAYMENT_PROVIDER set to an unsupported value (neither mock nor peach) fails closed', () => {
    const env = { ...VALID_ENV, PAYMENT_PROVIDER: 'stripe' }
    const report = validateEnvironment(env)
    expect(report.ok).toBe(false)
    expect(report.criticalFailures).toContain('PAYMENT_PROVIDER')
  })

  it('10. PAYMENT_PROVIDER=peach fully configured and valid, but the payout execution gate is OFF -- validation passes while real payout execution remains independently disabled', () => {
    const env = { ...VALID_PEACH_ENV, PEACH_PAYOUTS_EXECUTION_ENABLED: undefined } as unknown as NodeJS.ProcessEnv
    const report = validateEnvironment(env)
    expect(report.ok).toBe(true)
    // validateEnvironment has no knowledge of the execution gate at all --
    // it is a completely separate module (payout-execution/gate.ts) that
    // this phase deliberately does not merge into provider-selection
    // validation (phase brief: "do not collapse provider selection and
    // payout activation into one switch").
    expect(report.checks.some((c) => c.name === 'PEACH_PAYOUTS_EXECUTION_ENABLED')).toBe(false)
  })
})
