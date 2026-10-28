import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
}))

const { GET } = await import('../route')

interface RecordedCall {
  method: string
  args: unknown[]
}

/** D3-D: records every chained call so assertions can find the real-data filter regardless of call order; terminal tables (bookings, used only for a bounded booking-count lookup) resolve to an empty list. */
function fakeAdminClient(listingRows: unknown[], calls: RecordedCall[]) {
  return {
    from: (table: string) => {
      const obj: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'in', 'order', 'limit', 'gte', 'lte']) {
        obj[method] = (...args: unknown[]) => {
          if (table === 'listings') calls.push({ method, args })
          return obj
        }
      }
      obj.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
        resolve({ data: table === 'listings' ? listingRows : [], error: null })
      return obj
    },
  }
}

function call(searchParams = '') {
  return GET(new NextRequest(`http://localhost/api/admin/listings${searchParams}`))
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: 'admin', profile: {} } })
  getAdminServiceClient.mockReset()
})

describe('GET /api/admin/listings — real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  it('1. the queue filters is_test = false and the embedded merchant profile data_classification = \'real\' -- positive equality, scoped at the query level', async () => {
    const calls: RecordedCall[] = []
    getAdminServiceClient.mockResolvedValue(fakeAdminClient([], calls))
    await call()
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'is_test' && c.args[1] === false)).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'profiles.data_classification' && c.args[1] === 'real')).toBe(true)
  })

  it('2. the real-data filter composes with an existing category/riskTier filter, not replaces it', async () => {
    const calls: RecordedCall[] = []
    getAdminServiceClient.mockResolvedValue(fakeAdminClient([], calls))
    await call('?category=electronics&risk_tier=high')
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'is_test')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'category' && c.args[1] === 'electronics')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'risk_tier' && c.args[1] === 'high')).toBe(true)
  })

  it('3. zero real listings returns an empty, well-formed list without throwing', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient([], []))
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toEqual([])
  })

  it('4. admin authorization is required before any query runs', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getAdminServiceClient).not.toHaveBeenCalled()
  })
})
