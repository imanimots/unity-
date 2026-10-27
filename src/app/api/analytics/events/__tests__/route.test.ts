import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => Promise.resolve({ allowed: true, remaining: 10 }), getClientKey: () => '10.0.0.1' }))

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

/** fakeServiceRoleClient's `rpc` mock is typed with a single-arg signature even though it's called with two -- this reads the real runtime call args without fighting that narrow mock type. */
function rpcCallArgs(fnName: string): [string, Record<string, unknown>] | undefined {
  const calls = nextAdmin.rpc.mock.calls as unknown as Array<[string, Record<string, unknown>]>
  return calls.find((c) => c[0] === fnName)
}

function req(body: unknown, rawBody?: string) {
  return new NextRequest('http://localhost/api/analytics/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody ?? JSON.stringify(body),
  })
}

const LISTING_ID = '33333333-3333-4333-a333-333333333333'

beforeEach(() => {
  getRequestProfile.mockReset()
  getRequestProfile.mockResolvedValue(null) // anonymous by default
  nextAdmin = fakeServiceRoleClient({ listings: { data: null } }, { record_analytics_event: { data: null } })
})

describe('POST /api/analytics/events -- ingestion (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. accepts a valid allowlisted event and returns 202', async () => {
    const res = await POST(req({ eventId: randomUUID(), eventName: 'page_view' }))
    expect(res.status).toBe(202)
  })

  it('2. rejects an unknown event name with 400, never a 5xx or a silent 202', async () => {
    const res = await POST(req({ eventId: randomUUID(), eventName: 'payment_completed' }))
    expect(res.status).toBe(400)
  })

  it('3. rejects invalid metadata for the given event (an unknown field on a strict schema)', async () => {
    const res = await POST(req({ eventId: randomUUID(), eventName: 'page_view', metadata: { sneaky: 'x' } }))
    expect(res.status).toBe(400)
  })

  it('4. rejects an oversized request body outright, without ever parsing it as JSON', async () => {
    const res = await POST(req(null, 'x'.repeat(5000)))
    expect(res.status).toBe(400)
  })

  it('5. rejects malformed JSON with 400, not a 500', async () => {
    const res = await POST(req(null, '{not valid json'))
    expect(res.status).toBe(400)
  })

  it('6. is idempotent on event_id -- the RPC is called with the client-supplied eventId as p_event_id so a retried send is a no-op server-side (ON CONFLICT DO NOTHING is in the RPC, not this route)', async () => {
    const eventId = randomUUID()
    await POST(req({ eventId, eventName: 'page_view' }))
    expect(nextAdmin.rpc).toHaveBeenCalledWith('record_analytics_event', expect.objectContaining({ p_event_id: eventId }))
  })

  it('7. a client-supplied actorState/dataClassification in the raw body is never forwarded to the RPC -- actor_state is always server-derived', async () => {
    getRequestProfile.mockResolvedValue({ userId: 'u1', profile: { role: 'admin' } })
    const rawBody = JSON.stringify({ eventId: randomUUID(), eventName: 'page_view', actorState: 'admin-spoofed', dataClassification: 'real-spoofed' })
    await POST(req(null, rawBody))
    const call = rpcCallArgs('record_analytics_event')
    expect(call?.[1]).toMatchObject({ p_actor_state: 'admin' })
    expect(call?.[1].p_actor_state).not.toBe('admin-spoofed')
    expect(call?.[1].p_data_classification).not.toBe('real-spoofed')
  })

  it('8. strips a query string and hash from a client-supplied routePath before forwarding it', async () => {
    await POST(req({ eventId: randomUUID(), eventName: 'page_view', routePath: '/browse?email=a@b.com&token=secret#section' }))
    const call = rpcCallArgs('record_analytics_event')
    expect(call?.[1].p_route_path).toBe('/browse')
  })

  it('9. a listing-scoped event is classified from the listing\'s real is_test column (is_test = true -> "test")', async () => {
    nextAdmin = fakeServiceRoleClient({ listings: { data: { is_test: true } } }, { record_analytics_event: { data: null } })
    await POST(req({ eventId: randomUUID(), eventName: 'listing_viewed', entityType: 'listing', entityId: LISTING_ID }))
    const call = rpcCallArgs('record_analytics_event')
    expect(call?.[1].p_data_classification).toBe('test')
  })

  it('10. a non-listing-scoped event (e.g. page_view) is always classified "unknown" -- never guessed as real', async () => {
    await POST(req({ eventId: randomUUID(), eventName: 'page_view' }))
    const call = rpcCallArgs('record_analytics_event')
    expect(call?.[1].p_data_classification).toBe('unknown')
  })

  it('11. never exposes an internal RPC failure to the client -- still 202, no error body, no stack trace, no Postgres detail', async () => {
    nextAdmin = fakeServiceRoleClient({ listings: { data: null } }, { record_analytics_event: { data: null, error: { code: '42703', message: 'column analytics_events.whatever does not exist' } } })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(req({ eventId: randomUUID(), eventName: 'page_view' }))
    expect(res.status).toBe(202)
    const text = await res.text()
    expect(text).not.toMatch(/42703/)
    expect(text).not.toMatch(/does not exist/)
    consoleErrorSpy.mockRestore()
  })

  it('12. still returns 202 (never a blocking error) when analytics storage is not configured', async () => {
    // Force getAdminServiceClient() to see no URL/key configured.
    const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = await POST(req({ eventId: randomUUID(), eventName: 'page_view' }))
    expect(res.status).toBe(202)
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey
  })
})
