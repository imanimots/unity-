import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const checkRateLimit = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  getClientKey: () => 'test-client',
}))

const chargeRental = vi.fn()
vi.mock('@/lib/payments/registry', () => ({ getPaymentProvider: () => ({ name: 'mock', chargeRental: (...args: unknown[]) => chargeRental(...args) }) }))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

const AGREEMENT_ID = '11111111-1111-1111-1111-111111111111'
const CUSTOMER_ID = '22222222-2222-2222-2222-222222222222'

function req(body: unknown = {}) {
  return new NextRequest(`http://localhost/api/rent-to-buy/agreements/${AGREEMENT_ID}/payoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
    body: JSON.stringify(body),
  })
}
function call(body: unknown = {}) {
  return POST(req(body), { params: Promise.resolve({ id: AGREEMENT_ID }) })
}

/** fakeServiceRoleClient's rpc mock is typed as a 1-arg function; the real admin.rpc(name, params) call still passes params at runtime. */
function rpcParams(call: unknown[] | undefined): Record<string, unknown> {
  return (call as unknown[])[1] as Record<string, unknown>
}

const AGREEMENT_ROW = { customer_id: CUSTOMER_ID, merchant_id: 'merchant-1', currency: 'ZAR' }
const SCHEDULED_ROWS = [
  { sequence: 2, principal_amount: '100.00' },
  { sequence: 3, principal_amount: '150.00' },
]

function makeAdmin(overrides: Partial<Record<string, { data: unknown; error?: unknown }>> = {}, rpcResponses: Record<string, { data: unknown; error?: unknown }> = {}) {
  return fakeServiceRoleClient(
    {
      rent_to_buy_agreements: { data: AGREEMENT_ROW },
      rent_to_buy_installments: { data: SCHEDULED_ROWS },
      payments: { data: null },
      ...overrides,
    },
    {
      create_rent_to_buy_payment_intent: { data: { payment_id: 'pay-1' }, error: null },
      record_payment_attempt: { data: {}, error: null },
      transition_payment_status: { data: {}, error: null },
      payoff_rent_to_buy_agreement: { data: { status: 'completed', amount_paid: 250 }, error: null },
      ...rpcResponses,
    }
  )
}

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: CUSTOMER_ID })
  checkRateLimit.mockReset().mockResolvedValue({ allowed: true })
  chargeRental.mockReset()
})

describe('POST /api/rent-to-buy/agreements/[id]/payoff -- P5D-B.2 snapshot + requires_action correctness', () => {
  it('1/2/3. builds the authoritative server-generated payoff snapshot (sequence + principal_amount) and passes it as p_payoff_sequences, never client-supplied', async () => {
    chargeRental.mockResolvedValue({ status: 'captured', providerReference: 'ref-1' })
    nextAdmin = makeAdmin()

    await call({})

    const intentCall = nextAdmin.rpc.mock.calls.find((c) => c[0] === 'create_rent_to_buy_payment_intent')
    expect(intentCall).toBeDefined()
    expect(rpcParams(intentCall)).toMatchObject({ p_payoff_sequences: [2, 3], p_amount: 250 })
    expect(rpcParams(intentCall)).not.toHaveProperty('p_installment_sequence')
  })

  it('4/5/6. requires_action returns paymentId/status/redirectUrl, and does NOT transition captured or call payoff_rent_to_buy_agreement', async () => {
    chargeRental.mockResolvedValue({ status: 'requires_action', providerReference: 'ref-1', redirectUrl: 'https://pay.example/session' })
    nextAdmin = makeAdmin()

    const res = await call({})
    const body = await res.json()

    expect(body).toEqual({ paymentId: 'pay-1', status: 'requires_action', redirectUrl: 'https://pay.example/session' })
    const rpcNames = nextAdmin.rpc.mock.calls.map((c) => c[0])
    expect(rpcNames).not.toContain('transition_payment_status')
    expect(rpcNames).not.toContain('payoff_rent_to_buy_agreement')
  })

  it('7. a provider decline does not progress payoff completion', async () => {
    chargeRental.mockResolvedValue({ status: 'failed', providerReference: 'ref-1', failureReason: 'card declined' })
    nextAdmin = makeAdmin()

    const res = await call({})

    expect(res.status).toBe(402)
    const rpcNames = nextAdmin.rpc.mock.calls.map((c) => c[0])
    expect(rpcNames).not.toContain('payoff_rent_to_buy_agreement')
    expect(rpcParams(nextAdmin.rpc.mock.calls.find((c) => c[0] === 'transition_payment_status'))).toMatchObject({ p_new_status: 'failed' })
  })

  it('8/9. a genuine captured result transitions the payment and invokes payoff completion, returning its structured "completed" outcome', async () => {
    chargeRental.mockResolvedValue({ status: 'captured', providerReference: 'ref-1' })
    nextAdmin = makeAdmin()

    const res = await call({})
    const body = await res.json()

    expect(body).toEqual({ status: 'completed', amount_paid: 250 })
    const transitionCall = nextAdmin.rpc.mock.calls.find((c) => c[0] === 'transition_payment_status')
    expect(rpcParams(transitionCall)).toMatchObject({ p_payment_id: 'pay-1', p_new_status: 'captured' })
    const payoffCall = nextAdmin.rpc.mock.calls.find((c) => c[0] === 'payoff_rent_to_buy_agreement')
    expect(rpcParams(payoffCall)).toMatchObject({ p_actor_user_id: CUSTOMER_ID, p_agreement_id: AGREEMENT_ID, p_payment_id: 'pay-1' })
  })

  it('10. a structured already_completed outcome is accepted as success', async () => {
    chargeRental.mockResolvedValue({ status: 'captured', providerReference: 'ref-1' })
    nextAdmin = makeAdmin({}, { payoff_rent_to_buy_agreement: { data: { status: 'already_completed', amount_paid: 250 }, error: null } })

    const res = await call({})
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'already_completed', amount_paid: 250 })
  })

  it('11. a payment_conflict outcome is never reported as a normal completion', async () => {
    chargeRental.mockResolvedValue({ status: 'captured', providerReference: 'ref-1' })
    nextAdmin = makeAdmin(
      {},
      { payoff_rent_to_buy_agreement: { data: { status: 'payment_conflict', conflicting_sequences: [2], conflicting_payment_ids: ['other-pay'] }, error: null } }
    )

    const res = await call({})
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.status).toBe('payment_conflict')
    expect(body.error).toBeDefined()
  })

  it('12. an invalid_snapshot outcome is never reported as a normal completion', async () => {
    chargeRental.mockResolvedValue({ status: 'captured', providerReference: 'ref-1' })
    nextAdmin = makeAdmin({}, { payoff_rent_to_buy_agreement: { data: { status: 'invalid_snapshot', reason: 'payment amount does not match the exact snapshot principal sum' }, error: null } })

    const res = await call({})
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.status).toBe('invalid_snapshot')
  })

  it('13. an already-captured payment (retry) never calls the provider again and goes straight to payoff completion', async () => {
    nextAdmin = makeAdmin({ payments: { data: { status: 'captured' } } })

    const res = await call({})
    const body = await res.json()

    expect(chargeRental).not.toHaveBeenCalled()
    expect(body).toEqual({ status: 'completed', amount_paid: 250 })
    const payoffCall = nextAdmin.rpc.mock.calls.find((c) => c[0] === 'payoff_rent_to_buy_agreement')
    expect(payoffCall).toBeDefined()
  })

  it('there is no remaining balance to pay off when every installment is already scheduled-empty', async () => {
    nextAdmin = makeAdmin({ rent_to_buy_installments: { data: [] } })

    const res = await call({})

    expect(res.status).toBe(409)
    expect(chargeRental).not.toHaveBeenCalled()
  })

  it('rejects a request from someone who is not the agreement customer', async () => {
    getRequestProfile.mockResolvedValue({ userId: 'not-the-customer' })
    nextAdmin = makeAdmin()

    const res = await call({})

    expect(res.status).toBe(403)
    expect(chargeRental).not.toHaveBeenCalled()
  })
})
