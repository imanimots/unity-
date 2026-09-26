import { describe, it, expect, vi } from 'vitest'
import { chargeRentToBuyDeposit } from '../charge-rent-to-buy-deposit'
import { OrchestrationError } from '../errors'

vi.mock('../../registry', () => ({ getPaymentProvider: vi.fn() }))
import { getPaymentProvider } from '../../registry'

/**
 * P5D-B.2: proves the RTB deposit charge no longer uses
 * authorizeDeposit() (manual-capture, the confirmed pre-existing bug --
 * pending -> captured was reached WITHOUT ever calling captureDeposit())
 * -- it now uses chargeRental() (automatic capture), exactly like every
 * other immediate-settlement payment type.
 */
function fakeAdmin(options: {
  agreementRow?: Record<string, unknown> | null
  existingPaymentRow?: Record<string, unknown> | null
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
      case 'record_rent_to_buy_deposit_payment':
        return options.recordResult ?? { data: { agreement_id: 'agr-1', deposit_paid: true }, error: null }
      default:
        throw new Error(`unexpected rpc call: ${name}`)
    }
  })
  const agreementsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.agreementRow ?? { id: 'agr-1', merchant_id: 'merchant-1', customer_id: 'customer-1', currency: 'ZAR', security_deposit_amount: '500.00' }, error: null }),
  }
  const paymentsChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.existingPaymentRow ?? null, error: null }),
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
    if (table === 'payments') return paymentsChain
    if (table === 'payment_attempts') return paymentAttemptsChain
    throw new Error(`unexpected table: ${table}`)
  })
  return { rpc, from, rpcCalls } as unknown as Parameters<typeof chargeRentToBuyDeposit>[0]['admin'] & { rpcCalls: typeof rpcCalls }
}

describe('chargeRentToBuyDeposit -- P5D-B.2 automatic-capture correction', () => {
  it('1/2. uses provider.chargeRental(), never authorizeDeposit()', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'captured', providerReference: 'ref-1' }), authorizeDeposit: vi.fn() }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    await chargeRentToBuyDeposit({ admin } as never, 'agr-1', 'idem-1')

    expect(provider.chargeRental).toHaveBeenCalledTimes(1)
    expect(provider.authorizeDeposit).not.toHaveBeenCalled()
  })

  it('3/4. requires_action stays pending and returns redirect info, without recording the deposit', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'requires_action', providerReference: 'ref-1', redirectUrl: 'https://pay.example/session' }) }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    const result = await chargeRentToBuyDeposit({ admin } as never, 'agr-1', 'idem-1')

    expect(result).toEqual({ paymentId: 'pay-1', status: 'requires_action', redirectUrl: 'https://pay.example/session' })
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('transition_payment_status')
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('record_rent_to_buy_deposit_payment')
  })

  it('6. a genuine captured result transitions the payment and calls record_rent_to_buy_deposit_payment exactly once', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'captured', providerReference: 'ref-1' }) }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    const result = await chargeRentToBuyDeposit({ admin } as never, 'agr-1', 'idem-1')

    expect(result).toEqual({ paymentId: 'pay-1', status: 'captured' })
    const recordCalls = admin.rpcCalls.filter((c) => c.name === 'record_rent_to_buy_deposit_payment')
    expect(recordCalls).toHaveLength(1)
    expect(recordCalls[0].params).toMatchObject({ p_agreement_id: 'agr-1', p_payment_id: 'pay-1' })
  })

  it('a provider decline transitions to failed and never records the deposit', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'failed', providerReference: 'ref-1', failureReason: 'card declined' }) }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    await expect(chargeRentToBuyDeposit({ admin } as never, 'agr-1', 'idem-1')).rejects.toThrow(OrchestrationError)
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('record_rent_to_buy_deposit_payment')
  })

  it('9/10/11/12. an already-captured deposit completes domain progression (crash recovery) before returning, and never calls the provider again', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn() }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({ existingPaymentRow: { id: 'pay-existing', status: 'captured' } })

    const result = await chargeRentToBuyDeposit({ admin } as never, 'agr-1', 'idem-1')

    expect(result).toEqual({ paymentId: 'pay-existing', status: 'captured' })
    expect(provider.chargeRental).not.toHaveBeenCalled()
    const recordCall = admin.rpcCalls.find((c) => c.name === 'record_rent_to_buy_deposit_payment')
    expect(recordCall).toBeDefined()
    expect(recordCall!.params).toMatchObject({ p_agreement_id: 'agr-1', p_payment_id: 'pay-existing' })
  })

  it('13. an already-captured deposit whose recovery RPC fails technically propagates the error, never silently reports ordinary success', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn() }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({ existingPaymentRow: { id: 'pay-existing', status: 'captured' }, recordResult: { data: null, error: new Error('deposit rpc infra failure') } })

    await expect(chargeRentToBuyDeposit({ admin } as never, 'agr-1', 'idem-1')).rejects.toThrow(OrchestrationError)
    expect(provider.chargeRental).not.toHaveBeenCalled()
  })

  it('an already-captured deposit\'s recovery accepts an already_paid: true RPC result as success, not a failure', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn() }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({
      existingPaymentRow: { id: 'pay-existing', status: 'captured' },
      recordResult: { data: { agreement_id: 'agr-1', deposit_paid: true, already_paid: true }, error: null },
    })

    const result = await chargeRentToBuyDeposit({ admin } as never, 'agr-1', 'idem-1')

    expect(result).toEqual({ paymentId: 'pay-existing', status: 'captured' })
  })

  it('14/15. requires_action still stays pending and returns redirect info -- unregressed by the recovery fix', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'requires_action', providerReference: 'ref-1', redirectUrl: 'https://pay.example/session' }) }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    const result = await chargeRentToBuyDeposit({ admin } as never, 'agr-1', 'idem-1')

    expect(result).toEqual({ paymentId: 'pay-1', status: 'requires_action', redirectUrl: 'https://pay.example/session' })
    expect(admin.rpcCalls.map((c) => c.name)).not.toContain('record_rent_to_buy_deposit_payment')
  })

  it('16. a fresh synchronous captured path still completes deposit domain progression exactly once -- unregressed by the recovery fix', async () => {
    const provider = { name: 'mock', chargeRental: vi.fn().mockResolvedValue({ status: 'captured', providerReference: 'ref-1' }) }
    vi.mocked(getPaymentProvider).mockReturnValue(provider as never)
    const admin = fakeAdmin({})

    const result = await chargeRentToBuyDeposit({ admin } as never, 'agr-1', 'idem-1')

    expect(result).toEqual({ paymentId: 'pay-1', status: 'captured' })
    const recordCalls = admin.rpcCalls.filter((c) => c.name === 'record_rent_to_buy_deposit_payment')
    expect(recordCalls).toHaveLength(1)
  })
})
