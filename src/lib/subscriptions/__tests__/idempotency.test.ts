import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { computeRequestPlanChangeHash, computeCancelPendingChangeHash, computeAdminCorrectHash } from '../idempotency'

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

describe('subscription idempotency hashes (category: Idempotency)', () => {
  it('1. computeRequestPlanChangeHash mirrors the RPC formula exactly: merchantId|targetPlanId|billingReference', () => {
    const hash = computeRequestPlanChangeHash('merchant-1', 'pro', 'mock_subscription_charge_abc')
    expect(hash).toBe(md5('merchant-1|pro|mock_subscription_charge_abc'))
  })

  it('2. a null/undefined billing reference renders as an empty string, matching coalesce(..., \'\') in SQL', () => {
    const withNull = computeRequestPlanChangeHash('merchant-1', 'starter', null)
    const withUndefined = computeRequestPlanChangeHash('merchant-1', 'starter', undefined)
    expect(withNull).toBe(md5('merchant-1|starter|'))
    expect(withNull).toBe(withUndefined)
  })

  it('3. computeCancelPendingChangeHash is a bare md5 of the merchant id', () => {
    expect(computeCancelPendingChangeHash('merchant-1')).toBe(md5('merchant-1'))
  })

  it('4. computeAdminCorrectHash mirrors merchantId|newPlanId|immediate', () => {
    expect(computeAdminCorrectHash('merchant-1', 'elite', true)).toBe(md5('merchant-1|elite|true'))
    expect(computeAdminCorrectHash('merchant-1', 'elite', false)).toBe(md5('merchant-1|elite|false'))
  })

  it('5. different inputs never collide for these fixtures', () => {
    const a = computeRequestPlanChangeHash('merchant-1', 'pro', 'ref-a')
    const b = computeRequestPlanChangeHash('merchant-1', 'pro', 'ref-b')
    expect(a).not.toBe(b)
  })
})
