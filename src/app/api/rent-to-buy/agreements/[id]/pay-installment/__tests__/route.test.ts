import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * E49 Phase U -- second defense layer on the client-supplied
 * test_scenario, matching
 * src/app/api/advertising/campaigns/[id]/fund/route.ts's pattern. Found
 * live during this phase: the UI component previously hardcoded
 * test_scenario: 'success' on every real "Pay instalment" click with
 * zero gating -- fixed separately (src/components/rent-to-buy/
 * agreement-detail-client.tsx); this covers the route's own independent
 * rejection regardless of what any client sends.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => Promise.resolve({ allowed: true }), getClientKey: () => 'test-client' }))

const chargeRentToBuyInstallment = vi.fn()
vi.mock('@/lib/payments/orchestrator/charge-rent-to-buy-installment', () => ({
  chargeRentToBuyInstallment: (...args: unknown[]) => chargeRentToBuyInstallment(...args),
}))

vi.mock('@/lib/rent-to-buy/notify', () => ({ notifyRentToBuyParty: vi.fn() }))

interface FakeTableConfig { data: unknown; error?: unknown }
function makeFakeAdmin(tables: Record<string, FakeTableConfig>) {
  function makeChain(resolved: FakeTableConfig) {
    const value = { data: resolved.data ?? null, error: resolved.error ?? null }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve(value),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(value).then(resolve, reject),
    }
    return chain
  }
  return { from: vi.fn((table: string) => makeChain(tables[table] ?? { data: null, error: null })) }
}

let nextAdmin: ReturnType<typeof makeFakeAdmin>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

const AGREEMENT_ID = '11111111-1111-1111-1111-111111111111'
const CUSTOMER_ID = '22222222-2222-2222-2222-222222222222'

function call(body: unknown) {
  const req = new NextRequest(`http://localhost/api/rent-to-buy/agreements/${AGREEMENT_ID}/pay-installment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return POST(req, { params: Promise.resolve({ id: AGREEMENT_ID }) })
}

const mutableEnv = process.env as Record<string, string | undefined>
const ORIGINAL_NODE_ENV = process.env.NODE_ENV

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: CUSTOMER_ID })
  chargeRentToBuyInstallment.mockReset()
  nextAdmin = makeFakeAdmin({
    rent_to_buy_agreements: { data: { customer_id: CUSTOMER_ID, merchant_id: 'merchant-1', status: 'active' } },
    rent_to_buy_installments: { data: { status: 'scheduled' } },
  })
})

afterEach(() => {
  mutableEnv.NODE_ENV = ORIGINAL_NODE_ENV
})

describe('POST /api/rent-to-buy/agreements/[id]/pay-installment -- test_scenario production safety', () => {
  it('rejects a client-supplied test_scenario in production before any charge is attempted', async () => {
    mutableEnv.NODE_ENV = 'production'

    const res = await call({ sequence: 2, test_scenario: 'success' })

    expect(res.status).toBe(400)
    expect(chargeRentToBuyInstallment).not.toHaveBeenCalled()
  })

  it('a normal production request with no test_scenario proceeds normally', async () => {
    mutableEnv.NODE_ENV = 'production'
    chargeRentToBuyInstallment.mockResolvedValue({ status: 'captured' })

    const res = await call({ sequence: 2 })

    expect(res.status).toBe(200)
    expect(chargeRentToBuyInstallment).toHaveBeenCalledWith(
      expect.objectContaining({ testRentalScenario: undefined }),
      AGREEMENT_ID,
      2,
      undefined
    )
  })

  it('an explicit test_scenario still works outside production', async () => {
    mutableEnv.NODE_ENV = 'test'
    chargeRentToBuyInstallment.mockResolvedValue({ status: 'captured' })

    const res = await call({ sequence: 2, test_scenario: 'declined' })

    expect(res.status).toBe(200)
    expect(chargeRentToBuyInstallment).toHaveBeenCalledWith(
      expect.objectContaining({ testRentalScenario: 'declined' }),
      AGREEMENT_ID,
      2,
      undefined
    )
  })
})
