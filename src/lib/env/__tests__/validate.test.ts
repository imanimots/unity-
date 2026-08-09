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

  it('3. fails when PAYMENT_PROVIDER is set to an unexpected value', () => {
    const env = { ...VALID_ENV, PAYMENT_PROVIDER: 'peach' }
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
