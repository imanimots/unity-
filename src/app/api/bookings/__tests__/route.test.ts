import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

// D2 (ADMIN-CONTROL-CENTRE-BATCH-D2) -- proves booking_created fires at
// the correct point (a genuine new booking insert) and nowhere else
// (not on a failed RPC call, not on an idempotent replay), per Section
// 41's "event not emitted twice accidentally" / "not emitted on failed
// operation" requirements. This does not re-test the route's own
// pre-existing business logic (eligibility, idempotency correctness,
// email dispatch) -- only the new analytics emission added in this
// phase.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fake-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => Promise.resolve({ allowed: true, remaining: 10 }), getClientKey: () => '10.0.0.1' }))

const checkIdempotentReplay = vi.fn()
vi.mock('@/lib/bookings/idempotency', () => ({
  checkIdempotentReplay: (...args: unknown[]) => checkIdempotentReplay(...args),
  computeCreateBookingRequestHash: () => 'fake-hash',
}))

vi.mock('@/lib/bookings/lazy-expiry', () => ({ triggerLazyExpirySweep: () => Promise.resolve() }))
vi.mock('@/lib/email', () => ({ sendTemplate: () => Promise.resolve(), loadBookingEmailContext: () => Promise.resolve(null) }))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const recordAnalyticsEvent = vi.fn()
vi.mock('@/lib/analytics/server', () => ({
  recordAnalyticsEvent: (...args: unknown[]) => recordAnalyticsEvent(...args),
  deriveActorState: (role: string | null | undefined) => (role === 'renter' || role === 'both' ? 'authenticated' : 'anonymous'),
}))

const { POST } = await import('../route')

const RENTER_ID = '22222222-2222-4222-a222-222222222222'
const LISTING_ID = '33333333-3333-4333-a333-333333333333'
const BOOKING_ID = '44444444-4444-4444-a444-444444444444'

function req(body: unknown) {
  return new NextRequest('http://localhost/api/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID_BODY = {
  listing_id: LISTING_ID,
  start_at: '2027-01-01T00:00:00Z',
  end_at: '2027-01-05T00:00:00Z',
}

beforeEach(() => {
  recordAnalyticsEvent.mockReset()
  recordAnalyticsEvent.mockResolvedValue(undefined)
  checkIdempotentReplay.mockReset()
  getRequestProfile.mockReset()
  getRequestProfile.mockResolvedValue({
    userId: RENTER_ID,
    profile: { role: 'renter', account_status: 'active', kyc_status: 'approved' },
  })
})

describe('POST /api/bookings -- booking_created analytics instrumentation (category: ADMIN-CONTROL-CENTRE-BATCH-D2)', () => {
  it('1. fires booking_created exactly once, with entityType booking and the real booking id, on a genuine successful creation', async () => {
    nextAdmin = fakeServiceRoleClient({ listings: { data: { is_test: false } } }, { create_booking_request: { data: { booking_id: BOOKING_ID } } })
    const res = await POST(req(VALID_BODY))
    expect(res.status).toBe(201)
    expect(recordAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(recordAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'booking_created', entityType: 'booking', entityId: BOOKING_ID })
    )
  })

  it('2. derives dataClassification from the booking\'s real listing (is_test = true -> "test")', async () => {
    nextAdmin = fakeServiceRoleClient({ listings: { data: { is_test: true } } }, { create_booking_request: { data: { booking_id: BOOKING_ID } } })
    await POST(req(VALID_BODY))
    expect(recordAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({ dataClassification: 'test' }))
  })

  it('3. never fires booking_created when the RPC returns an error', async () => {
    nextAdmin = fakeServiceRoleClient({ listings: { data: { is_test: false } } }, { create_booking_request: { data: null, error: { message: 'listing not available' } } })
    const res = await POST(req(VALID_BODY))
    expect(res.status).not.toBe(201)
    expect(recordAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('4. never fires booking_created on an idempotent replay -- only the original creation is a real new event', async () => {
    nextAdmin = fakeServiceRoleClient({ listings: { data: { is_test: false } } }, { create_booking_request: { data: { booking_id: BOOKING_ID } } })
    checkIdempotentReplay.mockResolvedValue({ status: 'replay', result: { booking_id: BOOKING_ID } })
    const res = await POST(req({ ...VALID_BODY, idempotency_key: 'a-stable-client-key-123' }))
    expect(res.status).toBe(201)
    expect(recordAnalyticsEvent).not.toHaveBeenCalled()
  })

  describe('D2-F1: server-side reliability (await, not fire-and-forget) + failure isolation', () => {
    it('5. the route awaits recordAnalyticsEvent -- by the time POST() resolves, the mocked promise has already settled, not merely been started', async () => {
      nextAdmin = fakeServiceRoleClient({ listings: { data: { is_test: false } } }, { create_booking_request: { data: { booking_id: BOOKING_ID } } })
      let settled = false
      recordAnalyticsEvent.mockImplementation(() => new Promise((resolve) => setTimeout(() => { settled = true; resolve(undefined) }, 10)))
      await POST(req(VALID_BODY))
      expect(settled).toBe(true)
    })

    it('6. a rejecting recordAnalyticsEvent (simulating an internal analytics failure the helper failed to swallow) still returns the core operation\'s own 201 success -- analytics failure never turns a successful booking into a 500', async () => {
      nextAdmin = fakeServiceRoleClient({ listings: { data: { is_test: false } } }, { create_booking_request: { data: { booking_id: BOOKING_ID } } })
      recordAnalyticsEvent.mockRejectedValue(new Error('analytics storage unavailable'))
      const res = await POST(req(VALID_BODY))
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.booking_id).toBe(BOOKING_ID)
    })

    it('7. recordAnalyticsEvent is called only after the RPC has already returned a successful booking_id -- never before the core operation succeeds', async () => {
      const callOrder: string[] = []
      nextAdmin = fakeServiceRoleClient({ listings: { data: { is_test: false } } }, { create_booking_request: { data: { booking_id: BOOKING_ID } } })
      const originalRpc = nextAdmin.rpc
      nextAdmin.rpc = ((...args: unknown[]) => {
        callOrder.push('rpc')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalRpc as any)(...args)
      }) as typeof nextAdmin.rpc
      recordAnalyticsEvent.mockImplementation(() => { callOrder.push('analytics'); return Promise.resolve() })
      await POST(req(VALID_BODY))
      expect(callOrder.indexOf('rpc')).toBeLessThan(callOrder.indexOf('analytics'))
    })
  })
})
