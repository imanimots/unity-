import { describe, it, expect, vi } from 'vitest'
import { reconcileOrchestrationPayment, completeAsyncPaymentBusinessProgression, type OrchestrationEvidence, type ReconciliationOutcome } from '../reconcile-orchestration-payment'

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

/**
 * Fake admin covering every domain-progression call shape
 * completeAsyncPaymentBusinessProgression can issue:
 * `.from('bookings').select().eq().maybeSingle()` (what the real,
 * unmodified checkAndRecordLateSuccessIfExpired() issues) and every RPC
 * name the function calls directly (order/booking/RTB/commission).
 */
function fakeProgressionAdmin(options: {
  bookingRow?: { status: string; payment_expired_at: string | null } | null
  markOrderPaidResult?: { data?: unknown; error?: unknown }
  recordLateSuccessResult?: { data?: unknown; error?: unknown }
  rentalAffiliateCommissionResult?: { data?: unknown; error?: unknown }
  rentalUnityCommissionResult?: { data?: unknown; error?: unknown }
  saleAffiliateCommissionResult?: { data?: unknown; error?: unknown }
  saleUnityCommissionResult?: { data?: unknown; error?: unknown }
  recordInstallmentResult?: { data?: unknown; error?: unknown }
  payoffResult?: { data?: unknown; error?: unknown }
}) {
  const rpcCalls: Array<{ name: string; params: unknown }> = []
  const bookingsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.bookingRow ?? null, error: null }),
  }
  const rpc = vi.fn(async (name: string, params: unknown) => {
    rpcCalls.push({ name, params })
    if (name === 'record_late_payment_reconciliation') return options.recordLateSuccessResult ?? { data: { booking_id: 'booking-1', recorded: true }, error: null }
    if (name === 'mark_order_paid') return options.markOrderPaidResult ?? { data: { order_id: 'order-1', status: 'paid' }, error: null }
    if (name === 'qualify_rental_payment_affiliate_commission') return options.rentalAffiliateCommissionResult ?? { data: { qualified: true, commission_id: 'affiliate-rental-1' }, error: null }
    if (name === 'qualify_rental_payment_unity_commission') return options.rentalUnityCommissionResult ?? { data: { qualified: true, commission_id: 'unity-rental-1' }, error: null }
    if (name === 'qualify_sale_affiliate_commission') return options.saleAffiliateCommissionResult ?? { data: { qualified: true, commission_id: 'affiliate-sale-1' }, error: null }
    if (name === 'qualify_sale_unity_commission') return options.saleUnityCommissionResult ?? { data: { qualified: true, commission_id: 'unity-sale-1' }, error: null }
    if (name === 'record_rent_to_buy_installment_payment') return options.recordInstallmentResult ?? { data: { installment_id: 'inst-1', status: 'paid', already_paid: false }, error: null }
    if (name === 'payoff_rent_to_buy_agreement') return options.payoffResult ?? { data: { status: 'completed', amount_paid: 100 }, error: null }
    throw new Error(`unexpected rpc call in progression test: ${name}`)
  })
  const from = vi.fn((table: string) => {
    if (table === 'bookings') return bookingsChain
    throw new Error(`unexpected table in progression test: ${table}`)
  })
  return { from, rpc, rpcCalls } as unknown as Parameters<typeof completeAsyncPaymentBusinessProgression>[0] & { rpcCalls: typeof rpcCalls }
}

function transitionedOutcome(overrides: Partial<Extract<ReconciliationOutcome, { outcome: 'transitioned' }>> = {}): ReconciliationOutcome {
  return {
    outcome: 'transitioned',
    paymentId: 'pay-1',
    from: 'pending',
    to: 'captured',
    paymentType: 'rental_charge',
    bookingId: null,
    orderId: null,
    rentToBuyAgreementId: null,
    renterId: null,
    metadata: {},
    ...overrides,
  }
}
function alreadyCurrentOutcome(overrides: Partial<Extract<ReconciliationOutcome, { outcome: 'already_current' }>> = {}): ReconciliationOutcome {
  return {
    outcome: 'already_current',
    paymentId: 'pay-1',
    status: 'captured',
    paymentType: 'rental_charge',
    bookingId: null,
    orderId: null,
    rentToBuyAgreementId: null,
    renterId: null,
    metadata: {},
    ...overrides,
  }
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
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'authorised' })
  })

  it('succeeded on a pending rental charge -> transitions to captured', async () => {
    const admin = fakeAdmin([payment({ status: 'pending' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'succeeded' }))
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'captured' })
  })

  it('failed on a pending payment -> transitions to failed', async () => {
    const admin = fakeAdmin([payment({ status: 'pending' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'failed' }))
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'failed' })
  })

  it('partially_captured on an authorised deposit -> transitions to partially_captured', async () => {
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: 'deposit' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'partially_captured' }))
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'authorised', to: 'partially_captured' })
  })

  it('cancelled on an authorised deposit -> released (context-sensitive)', async () => {
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: 'deposit' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'cancelled' }))
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'authorised', to: 'released' })
  })

  it('cancelled on an ordinary pending payment -> cancelled (context-sensitive)', async () => {
    const admin = fakeAdmin([payment({ status: 'pending', payment_type: 'rental_charge' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'cancelled' }))
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'cancelled' })
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
    expect(result).toMatchObject({ outcome: 'already_current', paymentId: 'pay-row-1', status: 'captured' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('requires_capture after already-authorised -> already_current', async () => {
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: 'deposit' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'requires_capture' }))
    expect(result).toMatchObject({ outcome: 'already_current', paymentId: 'pay-row-1', status: 'authorised' })
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

describe('reconcileOrchestrationPayment -- P5D-B.1 payment_type context guards', () => {
  // P5D-B.2: rent_to_buy_deposit moved from manual-capture to automatic-
  // capture (charge-rent-to-buy-deposit.ts now uses chargeRental(), never
  // authorizeDeposit()) -- see reconcile-orchestration-payment.ts's own
  // updated MANUAL_CAPTURE_PAYMENT_TYPES comment.
  const MANUAL_CAPTURE_TYPES = ['deposit', 'barter_deposit']
  const AUTOMATIC_CAPTURE_TYPES = ['rental_charge', 'order_payment', 'barter_cash_adjustment', 'rent_to_buy_installment', 'rent_to_buy_deposit']

  it.each(MANUAL_CAPTURE_TYPES)('requires_capture on a pending %s payment -> transitions to authorised', async (paymentType) => {
    const admin = fakeAdmin([payment({ status: 'pending', payment_type: paymentType })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'requires_capture' }))
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'authorised' })
  })

  it.each(AUTOMATIC_CAPTURE_TYPES)('requires_capture on a pending %s (automatic-capture) payment -> manual_review, no transition', async (paymentType) => {
    const admin = fakeAdmin([payment({ status: 'pending', payment_type: paymentType })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'requires_capture' }))
    expect(result.outcome).toBe('manual_review')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it.each(MANUAL_CAPTURE_TYPES)('cancelled on an authorised %s payment -> released', async (paymentType) => {
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: paymentType })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'cancelled' }))
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'authorised', to: 'released' })
  })

  it('cancelled on an ordinary pending (automatic-capture) payment -> cancelled', async () => {
    const admin = fakeAdmin([payment({ status: 'pending', payment_type: 'rental_charge' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'cancelled' }))
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'cancelled' })
  })

  it('cancelled on a non-manual-capture payment that is somehow already "authorised" -> manual_review, never labelled released', async () => {
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: 'rental_charge' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'cancelled' }))
    expect(result.outcome).toBe('manual_review')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it.each(MANUAL_CAPTURE_TYPES)('succeeded on an authorised %s payment -> manual_review (deposit capture requires the dedicated reasoned workflow, never a generic webhook transition)', async (paymentType) => {
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: paymentType })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'succeeded' }))
    expect(result.outcome).toBe('manual_review')
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('succeeded on a pending automatic-capture payment still transitions normally to captured -- the manual-capture guard does not affect ordinary charges', async () => {
    const admin = fakeAdmin([payment({ status: 'pending', payment_type: 'rental_charge' })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'succeeded' }))
    expect(result).toMatchObject({ outcome: 'transitioned', paymentId: 'pay-row-1', from: 'pending', to: 'captured' })
  })

  it.each(AUTOMATIC_CAPTURE_TYPES)('partially_captured on a %s (automatic-capture) payment -> manual_review, never guessed', async (paymentType) => {
    // Even if isValidPaymentTransition would otherwise permit it from an
    // authorised-like state, the payment_type guard is explicit and
    // independent -- this asserts the guard itself, not just the state
    // machine's own side-effect.
    const admin = fakeAdmin([payment({ status: 'authorised', payment_type: paymentType })])
    const result = await reconcileOrchestrationPayment(admin, evidence({ status: 'partially_captured' }))
    expect(result.outcome).toBe('manual_review')
    expect(admin.rpc).not.toHaveBeenCalled()
  })
})

describe('completeAsyncPaymentBusinessProgression -- booking + order async business-state progression', () => {
  it('not_applicable for outcomes that never represent a financial completion', async () => {
    const admin = fakeProgressionAdmin({})
    for (const outcome of [
      { outcome: 'pending_noop', paymentId: 'p1' },
      { outcome: 'stale', paymentId: 'p1', rawStatus: 'processing' },
      { outcome: 'manual_review', paymentId: 'p1', reason: 'x' },
      { outcome: 'unknown_payment' },
      { outcome: 'ambiguous_provider_reference' },
      { outcome: 'rejected_mismatch', paymentId: 'p1', reason: 'amount' },
      { outcome: 'unknown_status', paymentId: 'p1', rawStatus: 'x' },
    ] as ReconciliationOutcome[]) {
      const result = await completeAsyncPaymentBusinessProgression(admin, outcome)
      expect(result).toEqual({ outcome: 'not_applicable' })
    }
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('A. first async success: a transitioned outcome for a booking payment triggers checkAndRecordLateSuccessIfExpired', async () => {
    const admin = fakeProgressionAdmin({ bookingRow: { status: 'expired', payment_expired_at: '2026-01-01T00:00:00Z' } })
    const result = await completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ bookingId: 'booking-1' }))
    expect(result).toEqual({ outcome: 'completed' })
    expect(admin.rpcCalls.map((c) => c.name)).toContain('record_late_payment_reconciliation')
  })

  it('a booking not actually expired does not record a late-success marker (checkAndRecordLateSuccessIfExpired\'s own existing no-op condition)', async () => {
    const admin = fakeProgressionAdmin({ bookingRow: { status: 'active', payment_expired_at: null } })
    await completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ bookingId: 'booking-1' }))
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('record_late_payment_reconciliation')
  })

  it('A. first async success: a transitioned outcome for an order_payment triggers mark_order_paid with a deterministic idempotency key', async () => {
    const admin = fakeProgressionAdmin({})
    await completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ paymentId: 'pay-order-1', paymentType: 'order_payment', orderId: 'order-1' }))
    const call = admin.rpcCalls.find((c) => c.name === 'mark_order_paid')
    expect(call).toBeDefined()
    expect(call!.params).toMatchObject({ p_order_id: 'order-1', p_payment_id: 'pay-order-1' })
  })

  it('mark_order_paid is not called for a deposit/authorised outcome (order progression only fires on captured)', async () => {
    const admin = fakeProgressionAdmin({})
    await completeAsyncPaymentBusinessProgression(admin, alreadyCurrentOutcome({ status: 'authorised', paymentType: 'order_payment', orderId: 'order-1' }))
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('mark_order_paid')
  })

  it('C. legitimate already_current can recover missing progression: an already_current outcome at the qualifying target also triggers progression', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(admin, alreadyCurrentOutcome({ paymentId: 'pay-order-1', paymentType: 'order_payment', orderId: 'order-1' }))
    expect(result).toEqual({ outcome: 'completed' })
    expect(admin.rpcCalls.map((c) => c.name)).toContain('mark_order_paid')
  })

  it('B/D. a transient failure in mark_order_paid propagates (throws) rather than being swallowed -- the caller must not mark the webhook event processed', async () => {
    const admin = fakeProgressionAdmin({ markOrderPaidResult: { data: null, error: new Error('order rpc failed') } })
    await expect(
      completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ paymentId: 'pay-order-1', paymentType: 'order_payment', orderId: 'order-1' }))
    ).rejects.toThrow('order rpc failed')
  })

  it('B/C. retry after a transient progression failure: already_current now recovers the same (idempotent) mark_order_paid call and succeeds', async () => {
    // Simulates: attempt 1 -- payment transitioned but mark_order_paid
    // failed transiently (tested above). Attempt 2 (retry) -- payment
    // reconciliation now returns already_current (already captured),
    // and mark_order_paid succeeds this time -- confirmed idempotent
    // (safe to call again) via mark_order_paid's own "already paid ->
    // naturally idempotent" branch, reused here unmodified.
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(admin, alreadyCurrentOutcome({ paymentId: 'pay-order-1', paymentType: 'order_payment', orderId: 'order-1' }))
    expect(result).toEqual({ outcome: 'completed' })
  })

  it('E. non-success provider state (manual_review) never triggers order/booking progression', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(admin, { outcome: 'manual_review', paymentId: 'pay-1', reason: 'amount mismatch' })
    expect(result).toEqual({ outcome: 'not_applicable' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('a barter payment_type never triggers order/RTB-specific progression -- only the payment transition itself matters for barter', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ paymentType: 'barter_cash_adjustment', bookingId: null, orderId: null }))
    expect(result).toEqual({ outcome: 'completed' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })
})

describe('completeAsyncPaymentBusinessProgression -- P5D-B.2 RTB installment/payoff progression', () => {
  it('1. a captured installment payment with a persisted single-sequence correlation progresses that exact sequence', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(
      admin,
      transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_installment_sequence: 3 } })
    )
    expect(result).toEqual({ outcome: 'completed' })
    const call = admin.rpcCalls.find((c) => c.name === 'record_rent_to_buy_installment_payment')
    expect(call!.params).toMatchObject({ p_agreement_id: 'agr-1', p_sequence: 3, p_payment_id: 'pay-1' })
  })

  it('4/5. runs the same installment progression for both a fresh transition and a legitimate already_current recovery', async () => {
    const admin = fakeProgressionAdmin({})
    const outcome = alreadyCurrentOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_installment_sequence: 3 } })
    const result = await completeAsyncPaymentBusinessProgression(admin, outcome)
    expect(result).toEqual({ outcome: 'completed' })
    expect(admin.rpcCalls.map((c) => c.name)).toContain('record_rent_to_buy_installment_payment')
  })

  it('2. a captured payoff payment with a persisted payoff-sequence snapshot invokes payoff_rent_to_buy_agreement using the persisted renter_id as actor', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(
      admin,
      transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_payoff_sequences: [2, 3] } })
    )
    expect(result).toEqual({ outcome: 'completed' })
    const call = admin.rpcCalls.find((c) => c.name === 'payoff_rent_to_buy_agreement')
    expect(call!.params).toMatchObject({ p_actor_user_id: 'customer-1', p_agreement_id: 'agr-1', p_payment_id: 'pay-1' })
  })

  it('6. a completed payoff outcome is treated as success', async () => {
    const admin = fakeProgressionAdmin({ payoffResult: { data: { status: 'completed', amount_paid: 250 }, error: null } })
    const result = await completeAsyncPaymentBusinessProgression(
      admin,
      transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_payoff_sequences: [2, 3] } })
    )
    expect(result).toEqual({ outcome: 'completed' })
  })

  it('7. an already_completed payoff outcome is treated as success', async () => {
    const admin = fakeProgressionAdmin({ payoffResult: { data: { status: 'already_completed', amount_paid: 250 }, error: null } })
    const result = await completeAsyncPaymentBusinessProgression(
      admin,
      alreadyCurrentOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_payoff_sequences: [2, 3] } })
    )
    expect(result).toEqual({ outcome: 'completed' })
  })

  it('8. a payment_conflict payoff outcome enters safe permanent-review handling -- never thrown, never treated as completed', async () => {
    const admin = fakeProgressionAdmin({ payoffResult: { data: { status: 'payment_conflict', conflicting_sequences: [2] }, error: null } })
    const result = await completeAsyncPaymentBusinessProgression(
      admin,
      transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_payoff_sequences: [2, 3] } })
    )
    expect(result.outcome).toBe('manual_review')
  })

  it('9. an invalid_snapshot payoff outcome enters safe permanent-review handling -- never thrown, never treated as completed', async () => {
    const admin = fakeProgressionAdmin({ payoffResult: { data: { status: 'invalid_snapshot', reason: 'amount mismatch' }, error: null } })
    const result = await completeAsyncPaymentBusinessProgression(
      admin,
      transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_payoff_sequences: [2, 3] } })
    )
    expect(result.outcome).toBe('manual_review')
  })

  it('a genuine infrastructure error calling payoff_rent_to_buy_agreement propagates (throws), unlike a structured conflict', async () => {
    const admin = fakeProgressionAdmin({ payoffResult: { data: null, error: new Error('rpc infra failure') } })
    await expect(
      completeAsyncPaymentBusinessProgression(
        admin,
        transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_payoff_sequences: [2, 3] } })
      )
    ).rejects.toThrow('rpc infra failure')
  })

  it('10. neither correlation key present (legacy payment) never infers a sequence -- no guessing, safe permanent-review handling', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(
      admin,
      transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: {} })
    )
    expect(result.outcome).toBe('manual_review')
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('record_rent_to_buy_installment_payment')
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('payoff_rent_to_buy_agreement')
  })

  it('a payoff payment with no persisted renter_id is a safe permanent-review condition, never called with a null/undefined actor', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(
      admin,
      transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: null, metadata: { rent_to_buy_payoff_sequences: [2, 3] } })
    )
    expect(result.outcome).toBe('manual_review')
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('payoff_rent_to_buy_agreement')
  })

  it('a genuine infrastructure error calling record_rent_to_buy_installment_payment propagates (throws) for crash recovery', async () => {
    const admin = fakeProgressionAdmin({ recordInstallmentResult: { data: null, error: new Error('installment rpc failed') } })
    await expect(
      completeAsyncPaymentBusinessProgression(
        admin,
        transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_installment_sequence: 1 } })
      )
    ).rejects.toThrow('installment rpc failed')
  })
})

describe('completeAsyncPaymentBusinessProgression -- P5D-B.2 async commission entitlement', () => {
  it('rental_charge: a captured booking payment qualifies both rental affiliate and Unity commission', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ paymentType: 'rental_charge', bookingId: 'booking-1' }))
    expect(result).toEqual({ outcome: 'completed' })
    const names = admin.rpcCalls.map((c) => c.name)
    expect(names).toContain('qualify_rental_payment_affiliate_commission')
    expect(names).toContain('qualify_rental_payment_unity_commission')
    const affiliateCall = admin.rpcCalls.find((c) => c.name === 'qualify_rental_payment_affiliate_commission')
    expect(affiliateCall!.params).toMatchObject({ p_booking_id: 'booking-1', p_payment_id: 'pay-1' })
  })

  it('order_payment: a captured order payment qualifies both sale affiliate and Unity commission', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ paymentType: 'order_payment', orderId: 'order-1' }))
    expect(result).toEqual({ outcome: 'completed' })
    const names = admin.rpcCalls.map((c) => c.name)
    expect(names).toContain('qualify_sale_affiliate_commission')
    expect(names).toContain('qualify_sale_unity_commission')
  })

  it('already_current captured recovery re-runs commission qualification safely (idempotent by payment_id)', async () => {
    const admin = fakeProgressionAdmin({})
    const result = await completeAsyncPaymentBusinessProgression(admin, alreadyCurrentOutcome({ paymentType: 'order_payment', orderId: 'order-1' }))
    expect(result).toEqual({ outcome: 'completed' })
    expect(admin.rpcCalls.map((c) => c.name)).toContain('qualify_sale_affiliate_commission')
  })

  it('a transient failure in rental affiliate commission qualification propagates (throws) -- the webhook must not be marked processed', async () => {
    const admin = fakeProgressionAdmin({ rentalAffiliateCommissionResult: { data: null, error: new Error('affiliate rpc failed') } })
    await expect(completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ paymentType: 'rental_charge', bookingId: 'booking-1' }))).rejects.toThrow('affiliate rpc failed')
  })

  it('a transient failure in rental Unity commission qualification propagates (throws)', async () => {
    const admin = fakeProgressionAdmin({ rentalUnityCommissionResult: { data: null, error: new Error('unity rpc failed') } })
    await expect(completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ paymentType: 'rental_charge', bookingId: 'booking-1' }))).rejects.toThrow('unity rpc failed')
  })

  it('a transient failure in sale affiliate commission qualification propagates (throws)', async () => {
    const admin = fakeProgressionAdmin({ saleAffiliateCommissionResult: { data: null, error: new Error('sale affiliate rpc failed') } })
    await expect(completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ paymentType: 'order_payment', orderId: 'order-1' }))).rejects.toThrow('sale affiliate rpc failed')
  })

  it('a transient failure in sale Unity commission qualification propagates (throws)', async () => {
    const admin = fakeProgressionAdmin({ saleUnityCommissionResult: { data: null, error: new Error('sale unity rpc failed') } })
    await expect(completeAsyncPaymentBusinessProgression(admin, transitionedOutcome({ paymentType: 'order_payment', orderId: 'order-1' }))).rejects.toThrow('sale unity rpc failed')
  })

  it('commission qualification never runs for an RTB installment payment (commission is qualified once at settlement, never per-payment)', async () => {
    const admin = fakeProgressionAdmin({})
    await completeAsyncPaymentBusinessProgression(
      admin,
      transitionedOutcome({ paymentType: 'rent_to_buy_installment', rentToBuyAgreementId: 'agr-1', renterId: 'customer-1', metadata: { rent_to_buy_installment_sequence: 1 } })
    )
    const names = admin.rpcCalls.map((c) => c.name)
    expect(names).not.toContain('qualify_rental_payment_affiliate_commission')
    expect(names).not.toContain('qualify_sale_affiliate_commission')
  })
})
