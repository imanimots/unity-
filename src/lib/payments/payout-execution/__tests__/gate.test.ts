import { describe, it, expect } from 'vitest'
import { isPayoutExecutionEnabled, assertPeachEnvironmentConsistency, PayoutEnvironmentMismatchError } from '../gate'

describe('isPayoutExecutionEnabled', () => {
  it('1. defaults false when absent', () => {
    expect(isPayoutExecutionEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false)
  })

  it('2. only the exact string "true" enables it -- never a truthy-string coercion', () => {
    expect(isPayoutExecutionEnabled({ PEACH_PAYOUTS_EXECUTION_ENABLED: 'TRUE' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isPayoutExecutionEnabled({ PEACH_PAYOUTS_EXECUTION_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isPayoutExecutionEnabled({ PEACH_PAYOUTS_EXECUTION_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
})

describe('assertPeachEnvironmentConsistency -- E34 app/Peach environment cross-check', () => {
  it('3. allows sandbox from a non-production app environment', () => {
    expect(() => assertPeachEnvironmentConsistency('sandbox', { NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv)).not.toThrow()
  })

  it('4. allows production from a real production app environment', () => {
    expect(() => assertPeachEnvironmentConsistency('production', { NODE_ENV: 'production', VERCEL_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).not.toThrow()
  })

  it('5. CRITICAL: rejects sandbox from a real production app environment without the explicit certification escape hatch', () => {
    expect(() => assertPeachEnvironmentConsistency('sandbox', { NODE_ENV: 'production', VERCEL_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toThrow(PayoutEnvironmentMismatchError)
  })

  it('6. allows sandbox from real production ONLY with PEACH_SANDBOX_CERTIFICATION_MODE="true"', () => {
    expect(() =>
      assertPeachEnvironmentConsistency('sandbox', { NODE_ENV: 'production', VERCEL_ENV: 'production', PEACH_SANDBOX_CERTIFICATION_MODE: 'true' } as unknown as NodeJS.ProcessEnv)
    ).not.toThrow()
  })

  it('7. the certification escape hatch requires the exact string "true" -- never a truthy coercion', () => {
    expect(() =>
      assertPeachEnvironmentConsistency('sandbox', { NODE_ENV: 'production', VERCEL_ENV: 'production', PEACH_SANDBOX_CERTIFICATION_MODE: 'yes' } as unknown as NodeJS.ProcessEnv)
    ).toThrow(PayoutEnvironmentMismatchError)
  })

  it('8. CRITICAL: rejects production from a preview app environment -- no accidental live payout from preview', () => {
    expect(() => assertPeachEnvironmentConsistency('production', { NODE_ENV: 'production', VERCEL_ENV: 'preview' } as unknown as NodeJS.ProcessEnv)).toThrow(PayoutEnvironmentMismatchError)
  })

  it('9. CRITICAL: rejects production from local development too', () => {
    expect(() => assertPeachEnvironmentConsistency('production', { NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv)).toThrow(PayoutEnvironmentMismatchError)
  })

  it('10. the certification escape hatch has no effect on the production-from-non-production direction -- it only ever relaxes the opposite case', () => {
    expect(() =>
      assertPeachEnvironmentConsistency('production', { NODE_ENV: 'production', VERCEL_ENV: 'preview', PEACH_SANDBOX_CERTIFICATION_MODE: 'true' } as unknown as NodeJS.ProcessEnv)
    ).toThrow(PayoutEnvironmentMismatchError)
  })

  it('11. NODE_ENV=test is never treated as real production, matching isMockPaymentAuthorityAllowed\'s own precedent', () => {
    expect(() => assertPeachEnvironmentConsistency('sandbox', { NODE_ENV: 'test', VERCEL_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).not.toThrow()
  })
})
