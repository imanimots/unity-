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

function fakeAdvertisersAdmin(calls: RecordedCall[]) {
  const obj: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'limit']) {
    obj[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return obj
    }
  }
  obj.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })
  return { from: () => obj }
}

function call() {
  return GET(new NextRequest('http://localhost/api/admin/advertising/advertisers'))
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: 'admin', profile: {} } })
  getAdminServiceClient.mockReset()
})

describe('GET /api/admin/advertising/advertisers — real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('1. filters is_test=false and the embedded owner profile data_classification=\'real\'', async () => {
    const calls: RecordedCall[] = []
    getAdminServiceClient.mockResolvedValue(fakeAdvertisersAdmin(calls))
    await call()
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'is_test' && c.args[1] === false)).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'profiles.data_classification' && c.args[1] === 'real')).toBe(true)
  })

  it('2. zero real advertisers returns an empty, well-formed list without throwing', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdvertisersAdmin([]))
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.advertisers).toEqual([])
  })

  it('3. admin authorization is required before any query runs', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getAdminServiceClient).not.toHaveBeenCalled()
  })
})
