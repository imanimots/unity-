import { describe, it, expect, vi } from 'vitest'
import { reconcileOrchestrationPayment, type OrchestrationEvidence } from '../reconcile-orchestration-payment'

/**
 * Lightweight fake of the two Supabase calls this function makes --
 * `.from('payments').select().eq().eq().limit()` and
 * `.rpc('transition_payment_status', ...)` -- same DB-free convention
 * as pending-provider-attempt-guard.test.ts. `rows` is what the lookup
 * resolves to; `rpcResult` is what the transition RPC resolves to
 * (default: success).
 */
function fakeAdmin(rows: unknown[], rpcResult: { data?: unknown; error?: unknown } = { data: {}, error: null }) {
  const selectChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
  }
  const rpc = vi.fn().mockResolvedValue(rpcResult)
  return { from: vi.fn().mockReturnValue(selectChain), rpc, __selectChain: selectChain } as unknown as Parameters<typeof reconcileOrchestrationPayment>[0] & {
    __selectChain: typeof selectChain
    rpc: typeof rpc
  }
}

function payment(overrides: Partial<{ id: string; status: string; payment_type: string; amount: string; currency: string }> = {}) {
  return { id: 'pay-row-1', status: 'pending', payment_type: 'rental_charge', amount: '92.00', currency: 'ZAR', ...overrides }
}

function evidence(overrides: Partial<OrchestrationEvidence> = {}): OrchestrationEvidence {
  return { paymentId: 'peach_pay_1', status: 'succeeded', amountMinorUnits: 9200, currency: 'ZAR', source: 'webhook', providerEventId: 'evt_1', ...overrides }
}

describe('reconcileOrchestrationPayment -- payment lookup', () => {
  it('0 matches -> unknown_payment, no transition attempted', async () => {
    const admin = fakeAdmin([])
    const result = await reconcileOrchestrationPayment(admin, evidence())
    expect(result).toEqual({ outcome: 'unknown_payment' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('1 match -> continues to reconciliation', async () => {
    const admin = fakeAdmin([payment()])
    const result = await reconcileOrchestrationPayment(admin, evidence())
    expect(result.outcome).toBe('transitioned')
  })

  it('>1 matches -> ambiguous_provider_reference, no transition attempted, never picks the first row', async () => {
    const admin = fakeAdmin([payment({ id: 'a' }), payment({ id: 'b' })])
    const result = await reconcileOrchestrationPayment(admin, evidence())
    expect(result).toEqual({ outcome: 'ambiguous_provider_reference' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('scopes the lookup by provider=peach and provider_reference=evidence.paymentId', async () => {
    const admin = fakeAdmin([payment()])
    await reconcileOrchestrationPayment(admin, evidence({ paymentId: 'peach_specific_id' }))
    expect(admin.__selectChain.eq).toHaveBeenCalledWith('provider', 'peach')
    expect(admin.__selectChain.eq).toHaveBeenCalledWith('provider_reference', 'peach_specific_id')
  })
})

describe('reconcileOrchestrationPayment -- metadata cross-check', () => {
  it('a matching unity_payment_id in metadata is accepted (supporting evidence only)', async () => {
    const admin = fakeAdmin([payment({ id: 'pay-row-1' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ metadata: { unity_payment_id: 'pay-row-1' } }))
    expect(result.outcome).toBe('transitioned')
  })

  it('a disagreeing unity_payment_id -> manual_review, no transition, never redirects to the metadata-named row', async () => {
    const admin = fakeAdmin([payment({ id: 'pay-row-1' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ metadata: { unity_payment_id: 'some-other-row-id' } }))
    expect(result.outcome).toBe('manual_review')
    expect(admin.rpc).not.toHaveBeenCalled()
  })
})

describe('reconcileOrchestrationPayment -- amount reconciliation', () => {
  it('exact amount match proceeds to transition', async () => {
    const admin = fakeAdmin([payment({ amount: '92.00' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ amountMinorUnits: 9200 }))
    expect(result.outcome).toBe('transitioned')
  })

  it('amount mismatch -> rejected_mismatch(amount), no transition', async () => {
    const admin = fakeAdmin([payment({ amount: '92.00' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ amountMinorUnits: 9999 }))
    expect(result).toEqual({ outcome: 'rejected_mismatch', paymentId: 'pay-row-1', reason: 'amount' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('missing provider amount on a state-advancing transition -> rejected_mismatch(amount), never guessed', async () => {
    const admin = fakeAdmin([payment()])
    const result = await reconcileOrchestrationPayment(admin, evidence({ amountMinorUnits: undefined }))
    expect(result).toEqual({ outcome: 'rejected_mismatch', paymentId: 'pay-row-1', reason: 'amount' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('converts via toMinorUnits -- no floating point (0.1 + 0.2 class amounts convert exactly)', async () => {
    const admin = fakeAdmin([payment({ amount: '0.30' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ amountMinorUnits: 30 }))
    expect(result.outcome).toBe('transitioned')
  })
})

describe('reconcileOrchestrationPayment -- currency reconciliation', () => {
  it('exact currency match proceeds', async () => {
    const admin = fakeAdmin([payment({ currency: 'ZAR' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ currency: 'ZAR' }))
    expect(result.outcome).toBe('transitioned')
  })

  it('currency mismatch -> rejected_mismatch(currency), no transition', async () => {
    const admin = fakeAdmin([payment({ currency: 'ZAR' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ currency: 'USD' }))
    expect(result).toEqual({ outcome: 'rejected_mismatch', paymentId: 'pay-row-1', reason: 'currency' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('missing provider currency -> rejected_mismatch(currency)', async () => {
    const admin = fakeAdmin([payment()])
    const result = await reconcileOrchestrationPayment(admin, evidence({ currency: undefined }))
    expect(result).toEqual({ outcome: 'rejected_mismatch', paymentId: 'pay-row-1', reason: 'currency' })
  })

  it('relies on the actual persisted currency, not a hardcoded ZAR assumption', async () => {
    const admin = fakeAdmin([payment({ currency: 'ZAR' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ currency: 'zar' }))
    // case-insensitive exact match against the persisted value, not a
    // global constant
    expect(result.outcome).toBe('transitioned')
  })
})

describe('reconcileOrchestrationPayment -- status normalization', () => {
  const noTransitionStatuses = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_customer_action', 'processing']

  it.each(noTransitionStatuses)('%s on a pending payment -> pending_noop, no transition RPC call', async (status) => {
    const admin = fakeAdmin([payment({ status: 'pending' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status }))
    expect(result).toEqual({ outcome: 'pending_noop', paymentId: 'pay-row-1' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('requires_capture on a pending deposit -> transitions to authorised', async () => {
    const admin = fakeAdmin([payment({ status: 'pending', payment_type: 'deposit' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'requires_capture' }))
    expect(result).toEqual({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'authorised' })
  })

  it('succeeded on a pending rental charge -> transitions to captured', async () => {
    const admin = fakeAdmin([payment({ status: 'pending' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'succeeded' }))
    expect(result).toEqual({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'captured' })
  })

  it('failed on a pending payment -> transitions to failed', async () => {
    const admin = fakeAdmin([payment({ status: 'pending' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'failed' }))
    expect(result).toEqual({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'failed' })
  })

  it('partially_captured on an authorised deposit -> transitions to partially_captured', async () => {
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: 'deposit' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'partially_captured' }))
    expect(result).toEqual({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'authorised', to: 'partially_captured' })
  })

  it('cancelled on an authorised deposit -> released (context-sensitive)', async () => {
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: 'deposit' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'cancelled' }))
    expect(result).toEqual({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'authorised', to: 'released' })
  })

  it('cancelled on an ordinary pending payment -> cancelled (context-sensitive)', async () => {
    const admin = fakeAdmin([payment({ status: 'pending', payment_type: 'rental_charge' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'cancelled' }))
    expect(result).toEqual({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'cancelled' })
  })

  it('unknown future status -> unknown_status, no transition RPC call', async () => {
    const admin = fakeAdmin([payment({ status: 'pending' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'some_future_status' }))
    expect(result).toEqual({ outcome: 'unknown_status', paymentId: 'pay-row-1', rawStatus: 'some_future_status' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })
})

describe('reconcileOrchestrationPayment -- stale/terminal protection (never regresses newer state)', () => {
  it('processing after captured -> stale, no transition', async () => {
    const admin = fakeAdmin([payment({ status: 'captured' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'processing' }))
    expect(result).toEqual({ outcome: 'stale', paymentId: 'pay-row-1', rawStatus: 'processing' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('requires_customer_action after captured -> stale', async () => {
    const admin = fakeAdmin([payment({ status: 'captured' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'requires_customer_action' }))
    expect(result.outcome).toBe('stale')
  })

  it('succeeded after already-captured -> already_current, no duplicate transition', async () => {
    const admin = fakeAdmin([payment({ status: 'captured' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'succeeded' }))
    expect(result).toEqual({ outcome: 'already_current', paymentId: 'pay-row-1', status: 'captured' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('requires_capture after already-authorised -> already_current', async () => {
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: 'deposit' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'requires_capture' }))
    expect(result).toEqual({ outcome: 'already_current', paymentId: 'pay-row-1', status: 'authorised' })
  })

  it('failed after captured -> manual_review, no transition attempted (invalid transition, never a silent no-op)', async () => {
    const admin = fakeAdmin([payment({ status: 'captured' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'failed' }))
    expect(result.outcome).toBe('manual_review')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('cancelled after captured -> manual_review, no transition attempted', async () => {
    const admin = fakeAdmin([payment({ status: 'captured' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'cancelled' }))
    expect(result.outcome).toBe('manual_review')
    expect(admin.rpc).not.toHaveBeenCalled()
  })
})

describe('reconcileOrchestrationPayment -- transition idempotency key', () => {
  it('webhook source: idempotency key is derived from providerEventId', async () => {
    const admin = fakeAdmin([payment({ status: 'pending' })])
    await reconcileOrchestrationPayment(admin, evidence({ status: 'succeeded', source: 'webhook', providerEventId: 'evt_42' }))
    const call = (admin.rpc as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('transition_payment_status')
    expect(call[1].p_idempotency_key).toBe('webhook:evt_42')
  })

  it('force_sync source: idempotency key is deterministic on (paymentId, target), not random or time-based', async () => {
    const admin1 = fakeAdmin([payment({ status: 'pending' })])
    await reconcileOrchestrationPayment(admin1, evidence({ status: 'succeeded', source: 'force_sync', providerEventId: undefined }))
    const call1 = (admin1.rpc as ReturnType<typeof vi.fn>).mock.calls[0]

    const admin2 = fakeAdmin([payment({ status: 'pending' })])
    await reconcileOrchestrationPayment(admin2, evidence({ status: 'succeeded', source: 'force_sync', providerEventId: undefined }))
    const call2 = (admin2.rpc as ReturnType<typeof vi.fn>).mock.calls[0]

    expect(call1[1].p_idempotency_key).toBe(call2[1].p_idempotency_key)
    expect(call1[1].p_idempotency_key).toBe('force_sync:pay-row-1:captured')
  })
})

describe('reconcileOrchestrationPayment -- infrastructure failures are never swallowed into a business outcome', () => {
  it('a lookup error throws rather than returning a handled outcome', async () => {
    const admin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: null, error: new Error('db down') }),
      }),
      rpc: vi.fn(),
    } as unknown as Parameters<typeof reconcileOrchestrationPayment>[0]
    await expect(reconcileOrchestrationPayment(admin, evidence())).rejects.toThrow('db down')
  })

  it('a transition RPC error throws rather than returning a handled outcome', async () => {
    const admin = fakeAdmin([payment({ status: 'pending' })], { data: null, error: new Error('rpc failed') })
    await expect(reconcileOrchestrationPayment(admin, evidence({ status: 'succeeded' }))).rejects.toThrow('rpc failed')
  })
})
