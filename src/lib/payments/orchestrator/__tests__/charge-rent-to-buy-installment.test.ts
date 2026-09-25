import { describe, it, expect, vi } from 'vitest'
import { chargeRentToBuyInstallment } from '../charge-rent-to-buy-installment'
import { OrchestrationError } from '../errors'

vi.mock('../../registry', () => ({ getPaymentProvider: vi.fn() }))
import { getPaymentProvider } from '../../registry'

/**
 * P5D-B.2: proves (1) the exact server-selected installment.sequence is
 * passed to create_rent_to_buy_payment_intent as p_installment_sequence
 * -- never a browser-supplied value, never encoded into the idempotency
 * key instead -- and (2) requires_action/captured are still handled
 * correctly after adding that parameter (no regression to the
 * already-correct provider-result branching).
 */
function fakeAdmin(options: {
  agreementRow?: Record<string, unknown> | null
  installmentRow?: Record<string, unknown> | null
  intentResult?: { data?: unknown; error?: unknown }
  latestAttemptStatus?: string | null
  recordResult?: { data?: unknown; error?: unknown }
}) {
  const rpcCalls: Array<{ name: string; params: unknown }> = []
  const rpc = vi.fn(async (name: string, params: unknown) => {
    rpcCalls.push({ name, params })
    switch (name) {
      case 'create_rent_to_buy_payment_intent':
        return options.intentResult ?? { data: { payment_id: 'pay-1' }, error: null }
      case 'record_payment_attempt':
        return { data: {}, error: null }
      case 'transition_payment_status':
        return { data: {}, error: null }
      case 'record_rent_to_buy_installment_payment':
        return options.recordResult ?? { data: { installment_id: 'inst-1', status: 'paid', already_paid: false }, error: null }
      default:
        throw new Error(`unexpected rpc call: ${name}`)
    }
  })
  const agreementsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.agreementRow ?? { id: 'agr-1', merchant_id: 'merchant-1', customer_id: 'customer-1', currency: 'ZAR', status: 'active' }, error: null }),
  }
  const installmentsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.installmentRow ?? { id: 'inst-1', sequence: 3, principal_amount: '150.00', status: 'scheduled', payment_id: null }, error: null }),
  }
  const paymentAttemptsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.latestAttemptStatus ? { status: options.latestAttemptStatus } : null }),
  }
  const from = vi.fn((table: string) => {
    if (table === 'rent_to_buy_agreements') return agreementsChain
    if (table === 'rent_to_buy_installments') return installmentsChain
    if (table === 'payment_attempts') return paymentAttemptsChain
    throw new Error(`unexpected table: ${table}`)
  })
  return { rpc, from, rpcCalls } as unknown as Parameters<typeof chargeRentToBuyInstallment>[0]['admin'] & { rpcCalls: typeof rpcCalls }
}

describe('chargeRentToBuyInstallment -- P5D-B.2 durable sequence correlation', () => {
  it('1. p_installment_sequence is passed from the authoritative, server-selected installment row', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'captured', providerReference: 'ref-1' }) }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    await chargeRentToBuyInstallment({ admin } as never, 'agr-1', 3, 'idem-1')

    const intentCall = admin.rpcCalls.find((c) => c.name === 'create_rent_to_buy_payment_intent')
    expect(intentCall).toBeDefined()
    expect(intentCall!.params).toMatchObject({ p_installment_sequence: 3, p_payment_type: 'rent_to_buy_installment' })
  })

  it('2. requires_action does not mark the installment paid and does not call record_rent_to_buy_installment_payment', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'requires_action', providerReference: 'ref-1', redirectUrl: 'https://pay.example/session' }) }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    const result = await chargeRentToBuyInstallment({ admin } as never, 'agr-1', 3, 'idem-1')

    expect(result).toEqual({ paymentId: 'pay-1', status: 'requires_action', installmentId: 'inst-1', redirectUrl: 'https://pay.example/session' })
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('record_rent_to_buy_installment_payment')
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('transition_payment_status')
  })

  it('3. a genuine captured result transitions the payment and progresses the exact persisted sequence', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'captured', providerReference: 'ref-1' }) }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    const result = await chargeRentToBuyInstallment({ admin } as never, 'agr-1', 3, 'idem-1')

    expect(result).toEqual({ paymentId: 'pay-1', status: 'captured', installmentId: 'inst-1' })
    const recordCall = admin.rpcCalls.find((c) => c.name === 'record_rent_to_buy_installment_payment')
    expect(recordCall!.params).toMatchObject({ p_agreement_id: 'agr-1', p_sequence: 3, p_payment_id: 'pay-1' })
    const transitionCall = admin.rpcCalls.find((c) => c.name === 'transition_payment_status')
    expect(transitionCall!.params).toMatchObject({ p_payment_id: 'pay-1', p_new_status: 'captured' })
  })

  it('4. a provider decline transitions to failed and never calls record_rent_to_buy_installment_payment', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'failed', providerReference: 'ref-1', failureReason: 'card declined' }) }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    await expect(chargeRentToBuyInstallment({ admin } as never, 'agr-1', 3, 'idem-1')).rejects.toThrow(OrchestrationError)
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('record_rent_to_buy_installment_payment')
    const transitionCall = admin.rpcCalls.find((c) => c.name === 'transition_payment_status')
    expect(transitionCall!.params).toMatchObject({ p_new_status: 'failed' })
  })

  it('5. an already-paid installment short-circuits before any provider call', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn() }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({ installmentRow: { id: 'inst-1', sequence: 3, principal_amount: '150.00', status: 'paid', payment_id: 'pay-existing' } })

    const result = await chargeRentToBuyInstallment({ admin } as never, 'agr-1', 3, 'idem-1')

    expect(result).toEqual({ paymentId: 'pay-existing', status: 'captured', installmentId: 'inst-1' })
    expect(provider.chargeRental).not.toHaveBeenCalled()
  })
})
