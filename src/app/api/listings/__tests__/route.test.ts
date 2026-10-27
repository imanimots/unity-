import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

// D2-F1 (ADMIN-CONTROL-CENTRE-BATCH-D2-F1) -- proves listing_creation_started
// fires exactly once on a genuine first draft creation, never on a
// network-level replay of that same create call (same idempotency_key),
// never on a failed RPC call, and never on an edit of an existing draft
// (listing_id present). Does not re-test the route's own pre-existing
// business logic (category-metadata sanitization, media-ownership
// checks) -- only the D2/D2-F1 analytics emission.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fake-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => Promise.resolve({ allowed: true, remaining: 10 }), getClientKey: () => '10.0.0.1' }))

const checkIdempotentReplay = vi.fn()
vi.mock('@/lib/bookings/idempotency', () => ({
  checkIdempotentReplay: (...args: unknown[]) => checkIdempotentReplay(...args),
}))

// The session-scoped (anon-key) client used for the actual RPC call.
let nextSessionRpcResult: { data: unknown; error: unknown }
vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      rpc: (..._args: unknown[]) => Promise.resolve(nextSessionRpcResult),
    }),
}))

// The service-role client used only for the pre-RPC idempotency_keys
// existence pre-check (D2-F1) -- a distinct client from the one above.
let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const recordAnalyticsEvent = vi.fn()
vi.mock('@/lib/analytics/server', () => ({
  recordAnalyticsEvent: (...args: unknown[]) => recordAnalyticsEvent(...args),
  deriveActorState: (role: string | null | undefined) => (role === 'merchant' || role === 'both' ? 'merchant' : 'authenticated'),
}))

const { POST } = await import('../route')

const MERCHANT_ID = '22222222-2222-4222-a222-222222222222'
const LISTING_ID = '33333333-3333-4333-a333-333333333333'

function req(body: unknown) {
  return new NextRequest('http://localhost/api/listings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const MINIMAL_CREATE_BODY = { listing: {} }

beforeEach(() => {
  recordAnalyticsEvent.mockReset()
  recordAnalyticsEvent.mockResolvedValue(undefined)
  checkIdempotentReplay.mockReset()
  checkIdempotentReplay.mockResolvedValue({ status: 'none' })
  getRequestProfile.mockReset()
  getRequestProfile.mockResolvedValue({ userId: MERCHANT_ID, profile: { role: 'merchant', account_status: 'active' } })
  nextAdmin = fakeServiceRoleClient({})
})

describe('POST /api/listings -- listing_creation_started analytics instrumentation (category: ADMIN-CONTROL-CENTRE-BATCH-D2-F1)', () => {
  it('1. fires listing_creation_started exactly once on a genuine first draft creation (no listing_id in the request)', async () => {
    nextSessionRpcResult = { data: LISTING_ID, error: null }
    const res = await POST(req(MINIMAL_CREATE_BODY))
    expect(res.status).toBe(200)
    expect(recordAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(recordAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'listing_creation_started', entityType: 'listing', entityId: LISTING_ID })
    )
  })

  it('2. never fires when the request is an edit of an existing draft (listing_id present)', async () => {
    nextSessionRpcResult = { data: LISTING_ID, error: null }
    const res = await POST(req({ ...MINIMAL_CREATE_BODY, listing_id: LISTING_ID }))
    expect(res.status).toBe(200)
    expect(recordAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('3. never fires when the RPC returns an error', async () => {
    nextSessionRpcResult = { data: null, error: { message: 'invalid or inactive category: none' } }
    const res = await POST(req(MINIMAL_CREATE_BODY))
    expect(res.status).not.toBe(200)
    expect(recordAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('4. never fires on a network-level replay of the create call -- a prior idempotency_keys row for this key means the RPC\'s success is a cached replay, not a fresh insert', async () => {
    nextSessionRpcResult = { data: LISTING_ID, error: null }
    checkIdempotentReplay.mockResolvedValue({ status: 'replay', result: { listing_id: LISTING_ID } })
    const res = await POST(req({ ...MINIMAL_CREATE_BODY, idempotency_key: 'a-stable-client-key-123' }))
    expect(res.status).toBe(200)
    expect(recordAnalyticsEvent).not.toHaveBeenCalled()
    // The pre-check runs BEFORE the RPC call -- confirmed by the RPC still succeeding (same mocked result) even though analytics is suppressed.
    const body = await res.json()
    expect(body.listing_id).toBe(LISTING_ID)
  })

  it('5. fires normally when an idempotency_key is supplied but no prior attempt exists for it', async () => {
    nextSessionRpcResult = { data: LISTING_ID, error: null }
    checkIdempotentReplay.mockResolvedValue({ status: 'none' })
    await POST(req({ ...MINIMAL_CREATE_BODY, idempotency_key: 'a-fresh-client-key-456' }))
    expect(recordAnalyticsEvent).toHaveBeenCalledTimes(1)
  })

  it('6. a rejecting recordAnalyticsEvent still returns the core operation\'s own success response -- analytics failure never turns a successful draft save into a 500', async () => {
    nextSessionRpcResult = { data: LISTING_ID, error: null }
    recordAnalyticsEvent.mockRejectedValue(new Error('analytics storage unavailable'))
    const res = await POST(req(MINIMAL_CREATE_BODY))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listing_id).toBe(LISTING_ID)
  })
})
