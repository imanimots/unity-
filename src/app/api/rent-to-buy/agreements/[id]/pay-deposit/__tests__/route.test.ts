import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

/**
 * E49 Phase U -- second defense layer on the client-supplied
 * test_scenario, matching
 * src/app/api/advertising/campaigns/[id]/fund/route.ts's pattern. Found
 * live during this phase: the UI component previously hardcoded
 * test_scenario: 'success' on every real "Pay deposit" click with zero
 * gating -- fixed separately (src/components/rent-to-buy/
 * agreement-detail-client.tsx); this covers the route's own independent
 * rejection regardless of what any client sends.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => Promise.resolve({ allowed: true }), getClientKey: () => 'test-client' }))

const chargeRentToBuyDeposit = vi.fn()
vi.mock('@/lib/payments/orchestrator/charge-rent-to-buy-deposit', () => ({
  chargeRentToBuyDeposit: (...args: unknown[]) => chargeRentToBuyDeposit(...args),
}))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

const AGREEMENT_ID = '11111111-1111-1111-1111-111111111111'
const CUSTOMER_ID = '22222222-2222-2222-2222-222222222222'

function call(body: unknown = {}) {
  const req = new NextRequest(`http://localhost/api/rent-to-buy/agreements/${AGREEMENT_ID}/pay-deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return POST(req, { params: Promise.resolve({ id: AGREEMENT_ID }) })
}

// process.env.NODE_ENV is typed read-only by @types/node -- same cast
// used by src/lib/advertising/__tests__/registry.test.ts.
const mutableEnv = process.env as Record<string, string | undefined>
const ORIGINAL_NODE_ENV = process.env.NODE_ENV

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: CUSTOMER_ID })
  chargeRentToBuyDeposit.mockReset()
  nextAdmin = fakeServiceRoleClient({ rent_to_buy_agreements: { data: { customer_id: CUSTOMER_ID } } })
})

afterEach(() => {
  mutableEnv.NODE_ENV = ORIGINAL_NODE_ENV
})

describe('POST /api/rent-to-buy/agreements/[id]/pay-deposit -- test_scenario production safety', () => {
  it('rejects a client-supplied test_scenario in production before any charge is attempted', async () => {
    mutableEnv.NODE_ENV = 'production'

    const res = await call({ test_scenario: 'success' })

    expect(res.status).toBe(400)
    expect(chargeRentToBuyDeposit).not.toHaveBeenCalled()
  })

  it('a normal production request with no test_scenario proceeds normally', async () => {
    mutableEnv.NODE_ENV = 'production'
    chargeRentToBuyDeposit.mockResolvedValue({ status: 'captured' })

    const res = await call({})

    expect(res.status).toBe(200)
    expect(chargeRentToBuyDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ testDepositScenario: undefined }),
      AGREEMENT_ID,
      undefined
    )
  })

  it('an explicit test_scenario still works outside production', async () => {
    mutableEnv.NODE_ENV = 'test'
    chargeRentToBuyDeposit.mockResolvedValue({ status: 'captured' })

    const res = await call({ test_scenario: 'declined' })

    expect(res.status).toBe(200)
    expect(chargeRentToBuyDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ testDepositScenario: 'declined' }),
      AGREEMENT_ID,
      undefined
    )
  })
})
