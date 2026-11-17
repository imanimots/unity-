import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// E48 Risk 2 -- proves the fund route's existing production-rejection
// gate actually works (previously untested), that an explicit test-mode
// scenario still functions in non-production, and that an unconfigured
// billing provider now fails honestly (503) instead of a raw uncaught
// exception or a fabricated success.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => Promise.resolve({ allowed: true, remaining: 10 }), getClientKey: () => '10.0.0.1' }))

vi.mock('@/lib/advertising/config', () => ({ isAdvertisingEnabled: () => true }))

const chargeMock = vi.fn()
const getAdvertisingBillingProvider = vi.fn()
vi.mock('@/lib/advertising/registry', () => ({ getAdvertisingBillingProvider: (...args: unknown[]) => getAdvertisingBillingProvider(...args) }))

interface FakeTableConfig { data: unknown; error?: unknown }

function makeFakeAdmin(tables: Record<string, FakeTableConfig> = {}, rpcs: Record<string, FakeTableConfig> = {}) {
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
  const from = vi.fn((table: string) => makeChain(tables[table] ?? { data: null, error: null }))
  const rpc = vi.fn((fn: string) => Promise.resolve(rpcs[fn] ?? { data: null, error: null }))
  return { from, rpc }
}

let nextAdmin: ReturnType<typeof makeFakeAdmin>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

const MERCHANT_ID = '11111111-1111-4111-a111-111111111111'
const CAMPAIGN_ID = '22222222-2222-4222-a222-222222222222'
const ADVERTISER_ID = '33333333-3333-4333-a333-333333333333'

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/advertising/campaigns/${CAMPAIGN_ID}/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// process.env.NODE_ENV is typed read-only by @types/node -- same cast
// used by src/lib/advertising/__tests__/registry.test.ts to mutate it
// directly and prove the real runtime guard it reads.
const mutableEnv = process.env as Record<string, string | undefined>
const ORIGINAL_NODE_ENV = process.env.NODE_ENV

beforeEach(() => {
  getRequestProfile.mockReset()
  getRequestProfile.mockResolvedValue({ userId: MERCHANT_ID })
  chargeMock.mockReset()
  getAdvertisingBillingProvider.mockReset()
  getAdvertisingBillingProvider.mockImplementation(() => ({ charge: chargeMock, refund: vi.fn() }))
})

afterEach(() => {
  mutableEnv.NODE_ENV = ORIGINAL_NODE_ENV
})

const CAMPAIGN_ROW = { advertiser_id: ADVERTISER_ID, is_test: true }
const QUOTE = { quote_id: 'quote-1', amount_due_cents: 5000, currency: 'ZAR' }

describe('POST /api/advertising/campaigns/[id]/fund -- mockScenario honesty', () => {
  it('rejects a client-supplied mockScenario outright in production, before ever charging anything', async () => {
    mutableEnv.NODE_ENV = 'production'
    nextAdmin = makeFakeAdmin(
      { ad_campaigns: { data: CAMPAIGN_ROW } },
      { create_ad_campaign_funding_quote: { data: QUOTE } }
    )

    const res = await POST(req({ fundingSource: 'provider', mockScenario: 'success' }), { params: Promise.resolve({ id: CAMPAIGN_ID }) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/mockScenario is not permitted/i)
    expect(chargeMock).not.toHaveBeenCalled()
  })

  it('accepts a normal production request with no mockScenario and lets the real provider decide', async () => {
    mutableEnv.NODE_ENV = 'production'
    nextAdmin = makeFakeAdmin(
      { ad_campaigns: { data: CAMPAIGN_ROW }, ad_provider_settlements: { data: null } },
      {
        create_ad_campaign_funding_quote: { data: QUOTE },
        record_ad_provider_settlement: { data: { id: 'settlement-1' } },
        fund_ad_campaign: { data: { funded: true } },
      }
    )
    chargeMock.mockResolvedValue({ providerReference: 'real_ref_1', status: 'succeeded' })

    const res = await POST(req({ fundingSource: 'provider' }), { params: Promise.resolve({ id: CAMPAIGN_ID }) })
    expect(res.status).toBe(200)
    expect(chargeMock).toHaveBeenCalledWith(expect.objectContaining({ mockScenario: undefined }))
  })

  it('an explicit test-mode scenario still works in a non-production environment', async () => {
    mutableEnv.NODE_ENV = 'test'
    nextAdmin = makeFakeAdmin(
      { ad_campaigns: { data: CAMPAIGN_ROW }, ad_provider_settlements: { data: null } },
      {
        create_ad_campaign_funding_quote: { data: QUOTE },
        record_ad_provider_settlement: { data: { id: 'settlement-1' } },
        fund_ad_campaign: { data: { funded: true } },
      }
    )
    chargeMock.mockResolvedValue({ providerReference: 'mock_ref_1', status: 'succeeded' })

    const res = await POST(req({ fundingSource: 'provider', mockScenario: 'success' }), { params: Promise.resolve({ id: CAMPAIGN_ID }) })
    expect(res.status).toBe(200)
    expect(chargeMock).toHaveBeenCalledWith(expect.objectContaining({ mockScenario: 'success' }))
  })

  it('a declined test scenario is honored -- no settlement is recorded and no campaign is funded', async () => {
    mutableEnv.NODE_ENV = 'test'
    nextAdmin = makeFakeAdmin(
      { ad_campaigns: { data: CAMPAIGN_ROW }, ad_provider_settlements: { data: null } },
      { create_ad_campaign_funding_quote: { data: QUOTE } }
    )
    chargeMock.mockResolvedValue({ providerReference: 'mock_ref_2', status: 'failed', failureReason: 'declined' })

    const res = await POST(req({ fundingSource: 'provider', mockScenario: 'declined' }), { params: Promise.resolve({ id: CAMPAIGN_ID }) })
    expect(res.status).toBe(402)
    // record_ad_provider_settlement and fund_ad_campaign must never be
    // called on a declined charge.
    expect(nextAdmin.rpc).not.toHaveBeenCalledWith('record_ad_provider_settlement', expect.anything())
    expect(nextAdmin.rpc).not.toHaveBeenCalledWith('fund_ad_campaign', expect.anything())
  })

  it('an unconfigured billing provider returns an honest 503, never a fabricated success', async () => {
    mutableEnv.NODE_ENV = 'test'
    nextAdmin = makeFakeAdmin(
      { ad_campaigns: { data: CAMPAIGN_ROW }, ad_provider_settlements: { data: null } },
      { create_ad_campaign_funding_quote: { data: QUOTE } }
    )
    getAdvertisingBillingProvider.mockImplementation(() => {
      throw new Error('Unknown advertising billing provider')
    })

    const res = await POST(req({ fundingSource: 'provider' }), { params: Promise.resolve({ id: CAMPAIGN_ID }) })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toMatch(/not configured/i)
    expect(chargeMock).not.toHaveBeenCalled()
  })
})
