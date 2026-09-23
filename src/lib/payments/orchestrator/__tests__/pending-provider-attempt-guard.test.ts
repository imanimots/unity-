import { describe, it, expect, vi } from 'vitest'
import { assertNoPendingProviderAttempt } from '../pending-provider-attempt-guard'
import { OrchestrationError } from '../errors'

/**
 * P5C.1. A lightweight fake of the one Supabase query chain this
 * function actually calls (`.from('payment_attempts').select().eq()
 * .order().limit().maybeSingle()`) -- consistent with this codebase's
 * own established convention that full orchestrator functions (which
 * make many RPC calls) are live-validated rather than DB-mocked, but
 * this one small, pure-ish guard is narrow enough to unit test safely.
 */
function fakeAdmin(latestAttemptStatus: string | null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: latestAttemptStatus === null ? null : { status: latestAttemptStatus } }),
  }
  return { from: vi.fn().mockReturnValue(chain) } as unknown as Parameters<typeof assertNoPendingProviderAttempt>[0]
}

describe('assertNoPendingProviderAttempt', () => {
  it('does not throw when no attempt exists yet', async () => {
    await expect(assertNoPendingProviderAttempt(fakeAdmin(null), 'p1')).resolves.toBeUndefined()
  })

  it('does not throw when the latest attempt already succeeded', async () => {
    await expect(assertNoPendingProviderAttempt(fakeAdmin('succeeded'), 'p1')).resolves.toBeUndefined()
  })

  it('does not throw when the latest attempt already failed (a fresh attempt is legitimate)', async () => {
    await expect(assertNoPendingProviderAttempt(fakeAdmin('failed'), 'p1')).resolves.toBeUndefined()
  })

  it('throws a duplicate_workflow_conflict OrchestrationError when the latest attempt is still pending -- prevents creating a second live Hosted Checkout session', async () => {
    const admin = fakeAdmin('pending')
    await expect(assertNoPendingProviderAttempt(admin, 'p1')).rejects.toThrow(OrchestrationError)
    try {
      await assertNoPendingProviderAttempt(fakeAdmin('pending'), 'p1')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError)
      expect((err as OrchestrationError).code).toBe('duplicate_workflow_conflict')
    }
  })

  it('queries payment_attempts scoped to the given paymentId, ordered by attempt_number descending, limited to 1', async () => {
    const admin = fakeAdmin(null)
    await assertNoPendingProviderAttempt(admin, 'payment-xyz')
    const chain = (admin as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.results[0].value
    expect((admin as unknown as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalledWith('payment_attempts')
    expect(chain.eq).toHaveBeenCalledWith('payment_id', 'payment-xyz')
    expect(chain.order).toHaveBeenCalledWith('attempt_number', { ascending: false })
    expect(chain.limit).toHaveBeenCalledWith(1)
  })
})
