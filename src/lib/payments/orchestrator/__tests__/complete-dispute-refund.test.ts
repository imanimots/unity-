import { describe, it, expect, vi } from 'vitest'
import { completeDisputeRefundWithProvider } from '../complete-dispute-refund'
import { NotImplementedError } from '../../provider'

vi.mock('../../registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../registry')>()
  return { ...actual, getActivePaymentProvider: vi.fn() }
})
import { getActivePaymentProvider, ProviderNotPermittedError } from '../../registry'

/**
 * E29: proves completeDisputeRefundWithProvider() never calls the
 * payment provider a second time once a refund has reached a terminal
 * state, never calls it at all while an earlier attempt is still
 * 'processing' (no provider-side idempotency key exists in this
 * abstraction to safely retry against), and correctly brackets the one
 * real provider call with start_refund_provider_attempt() /
 * record_refund_provider_result().
 */
function fakeAdmin(options: {
  refundRow?: Record<string, unknown> | null
  paymentRow?: Record<string, unknown> | null
  startResult?: { data?: unknown; error?: unknown }
  recordResult?: { data?: unknown; error?: unknown }
}) {
  const rpcCalls: Array<{ name: string; params: unknown }> = []
  const rpc = vi.fn(async (name: string, params: unknown) => {
    rpcCalls.push({ name, params })
    switch (name) {
      case 'start_refund_provider_attempt':
        return options.startResult ?? { data: { refund_id: 'refund-1', status: 'processing' }, error: null }
      case 'record_refund_provider_result':
        return options.recordResult ?? { data: { refund_id: 'refund-1', status: 'completed', disposition_completed: true }, error: null }
      default:
        throw new Error(`unexpected rpc call: ${name}`)
    }
  })
  const refundsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: options.refundRow === undefined ? { id: 'refund-1', payment_id: 'payment-1', amount: '250.00', reason: 'Renter overcharged', status: 'pending' } : options.refundRow,
    }),
  }
  const paymentsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: options.paymentRow === undefined ? { id: 'payment-1', provider_reference: 'prov-ref-1', currency: 'ZAR' } : options.paymentRow,
    }),
  }
  const from = vi.fn((table: string) => {
    if (table === 'refunds') return refundsChain
    if (table === 'payments') return paymentsChain
    throw new Error(`unexpected table: ${table}`)
  })
  return { admin: { rpc, from } as never, rpcCalls }
}

describe('completeDisputeRefundWithProvider -- resumability via refund status', () => {
  it('1. an already-completed refund returns immediately, never calls the provider or either RPC', async () => {
    const provider = { name: 'peach', supportsCapability: () => true, refund: vi.fn() }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin, rpcCalls } = fakeAdmin({ refundRow: { id: 'refund-1', payment_id: 'payment-1', amount: '250.00', reason: 'x', status: 'completed' } })

    const result = await completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')

    expect(result).toEqual({ refundId: 'refund-1', status: 'completed', dispositionCompleted: false })
    expect(provider.refund).not.toHaveBeenCalled()
    expect(rpcCalls).toEqual([])
  })

  it('2. an already-failed refund returns immediately, never calls the provider or either RPC', async () => {
    const provider = { name: 'peach', supportsCapability: () => true, refund: vi.fn() }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin, rpcCalls } = fakeAdmin({ refundRow: { id: 'refund-1', payment_id: 'payment-1', amount: '250.00', reason: 'x', status: 'failed' } })

    const result = await completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')

    expect(result).toEqual({ refundId: 'refund-1', status: 'failed', dispositionCompleted: false })
    expect(provider.refund).not.toHaveBeenCalled()
    expect(rpcCalls).toEqual([])
  })

  it('3. a refund already "processing" is refused outright -- never calls the provider again, since no provider-side idempotency key exists to safely retry against', async () => {
    const provider = { name: 'peach', supportsCapability: () => true, refund: vi.fn() }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin, rpcCalls } = fakeAdmin({ refundRow: { id: 'refund-1', payment_id: 'payment-1', amount: '250.00', reason: 'x', status: 'processing' } })

    await expect(completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')).rejects.toMatchObject({
      code: 'duplicate_workflow_conflict',
    })
    expect(provider.refund).not.toHaveBeenCalled()
    expect(rpcCalls).toEqual([])
  })

  it('4. refund not found throws missing_payment', async () => {
    const { admin } = fakeAdmin({ refundRow: null })
    await expect(completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')).rejects.toMatchObject({ code: 'missing_payment' })
  })

  it('5. payment not found (for a pending refund) throws missing_payment', async () => {
    const { admin } = fakeAdmin({ paymentRow: null })
    await expect(completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')).rejects.toMatchObject({ code: 'missing_payment' })
  })
})

describe('completeDisputeRefundWithProvider -- the happy path brackets exactly one provider call with the two RPCs', () => {
  it('6. calls start_refund_provider_attempt, then provider.refund with the refund amount/reason and the payment\'s own provider reference/currency, then record_refund_provider_result with the completed result', async () => {
    const provider = { name: 'peach', supportsCapability: () => true, refund: vi.fn().mockResolvedValue({ providerReference: 'peach-ref-9', status: 'completed' }) }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin, rpcCalls } = fakeAdmin({})

    const result = await completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1', 'idem-1')

    expect(rpcCalls.map((c) => c.name)).toEqual(['start_refund_provider_attempt', 'record_refund_provider_result'])
    expect(provider.refund).toHaveBeenCalledWith({
      paymentId: 'payment-1',
      providerReference: 'prov-ref-1',
      amount: 250,
      currency: 'ZAR',
      reason: 'Renter overcharged',
    })
    expect(rpcCalls[1].params).toMatchObject({ p_refund_id: 'refund-1', p_provider_status: 'completed', p_provider_reference: 'peach-ref-9' })
    expect(result).toEqual({ refundId: 'refund-1', status: 'completed', dispositionCompleted: true, failureReason: undefined })
  })

  it('7. a provider "failed" result is recorded as failed with its failure reason -- the linked disposition is never touched by this path (that happens, or not, inside record_refund_provider_result itself)', async () => {
    const provider = { name: 'peach', supportsCapability: () => true, refund: vi.fn().mockResolvedValue({ providerReference: 'peach-ref-9', status: 'failed', failureReason: 'insufficient_funds' }) }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin, rpcCalls } = fakeAdmin({ recordResult: { data: { refund_id: 'refund-1', status: 'failed', disposition_completed: false }, error: null } })

    const result = await completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')

    expect(rpcCalls[1].params).toMatchObject({ p_provider_status: 'failed', p_failure_reason: 'insufficient_funds' })
    expect(result).toEqual({ refundId: 'refund-1', status: 'failed', dispositionCompleted: false, failureReason: 'insufficient_funds' })
  })

  it('8. a provider stub throwing NotImplementedError (the live PeachPaymentsProvider today) is translated to provider_configuration_error, never a raw throw', async () => {
    const provider = { name: 'peach', supportsCapability: () => true, refund: vi.fn().mockRejectedValue(new NotImplementedError('peach', 'refund')) }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin, rpcCalls } = fakeAdmin({})

    await expect(completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')).rejects.toMatchObject({ code: 'provider_configuration_error' })
    // start_refund_provider_attempt still ran (the refund is left 'processing', not reverted) -- only record_refund_provider_result never runs.
    expect(rpcCalls.map((c) => c.name)).toEqual(['start_refund_provider_attempt'])
  })

  it('9. a failure from start_refund_provider_attempt itself never calls the provider at all', async () => {
    const provider = { name: 'peach', supportsCapability: () => true, refund: vi.fn() }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin } = fakeAdmin({ startResult: { data: null, error: { message: 'refund is not pending a provider attempt' } } })

    await expect(completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')).rejects.toMatchObject({ code: 'invalid_payment_transition' })
    expect(provider.refund).not.toHaveBeenCalled()
  })

  it('10. a failure from record_refund_provider_result after a successful provider call still surfaces as invalid_payment_transition', async () => {
    const provider = { name: 'peach', supportsCapability: () => true, refund: vi.fn().mockResolvedValue({ providerReference: 'peach-ref-9', status: 'completed' }) }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin } = fakeAdmin({ recordResult: { data: null, error: { message: 'refund is not awaiting a provider result' } } })

    await expect(completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')).rejects.toMatchObject({ code: 'invalid_payment_transition' })
  })

  it('11. passes the same idempotency key through to both RPC calls', async () => {
    const provider = { name: 'peach', supportsCapability: () => true, refund: vi.fn().mockResolvedValue({ providerReference: 'peach-ref-9', status: 'completed' }) }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin, rpcCalls } = fakeAdmin({})

    await completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1', 'idem-shared')

    expect((rpcCalls[0].params as Record<string, unknown>).p_idempotency_key).toBe('idem-shared')
    expect((rpcCalls[1].params as Record<string, unknown>).p_idempotency_key).toBe('idem-shared')
  })
})

describe('completeDisputeRefundWithProvider -- E30: environment permission and capability gates, both before start_refund_provider_attempt', () => {
  it('12. mock disallowed in this environment (e.g. production) surfaces as provider_configuration_error, and never marks the refund processing', async () => {
    vi.mocked(getActivePaymentProvider).mockImplementation(() => {
      throw new ProviderNotPermittedError('mock')
    })
    const { admin, rpcCalls } = fakeAdmin({})

    await expect(completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')).rejects.toMatchObject({ code: 'provider_configuration_error' })
    expect(rpcCalls).toEqual([])
  })

  it('13. a provider that does not support the refund capability (e.g. the live PeachPaymentsProvider today) rejects before start_refund_provider_attempt -- the refund must remain pending, never stranded in processing', async () => {
    const provider = { name: 'peach', supportsCapability: () => false, refund: vi.fn() }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin, rpcCalls } = fakeAdmin({})

    await expect(completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')).rejects.toMatchObject({ code: 'provider_configuration_error' })
    expect(provider.refund).not.toHaveBeenCalled()
    expect(rpcCalls).toEqual([])
  })

  it('14. the capability check asks specifically for "refund" -- never a different capability name', async () => {
    const supportsCapability = vi.fn().mockReturnValue(true)
    const provider = { name: 'peach', supportsCapability, refund: vi.fn().mockResolvedValue({ providerReference: 'peach-ref-9', status: 'completed' }) }
    vi.mocked(getActivePaymentProvider).mockReturnValue(provider as never)
    const { admin } = fakeAdmin({})

    await completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')

    expect(supportsCapability).toHaveBeenCalledWith('refund')
  })

  it('15. an already-terminal refund (completed/failed) never even resolves a provider -- the permission/capability gates are skipped entirely, not just satisfied', async () => {
    vi.mocked(getActivePaymentProvider).mockImplementation(() => {
      throw new Error('getActivePaymentProvider should never be called for an already-terminal refund')
    })
    const { admin } = fakeAdmin({ refundRow: { id: 'refund-1', payment_id: 'payment-1', amount: '250.00', reason: 'x', status: 'completed' } })

    const result = await completeDisputeRefundWithProvider({ admin } as never, 'refund-1', 'admin-1')
    expect(result.status).toBe('completed')
  })
})
