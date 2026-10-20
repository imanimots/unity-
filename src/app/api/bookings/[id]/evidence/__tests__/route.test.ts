import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

// The route's "storage not configured" 503 guard checks these directly --
// set to non-empty fakes so the route proceeds into the logic under test.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const checkIdempotentReplay = vi.fn()
vi.mock('@/lib/bookings/idempotency', () => ({
  checkIdempotentReplay: (...args: unknown[]) => checkIdempotentReplay(...args),
  computeRegisterBookingConditionEvidenceHash: () => 'fake-hash',
}))

const cleanupUnregisteredUpload = vi.fn()
vi.mock('@/lib/storage-cleanup', () => ({ cleanupUnregisteredUpload: (...args: unknown[]) => cleanupUnregisteredUpload(...args) }))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

// GET uses the cookie-bound asUser client, not the service-role one.
let fakeAsUserRows: unknown[] = []
vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: fakeAsUserRows, error: null }),
          }),
        }),
      }),
    }),
}))

const { POST, GET } = await import('../route')

const BOOKING_ID = '11111111-1111-1111-1111-111111111111'
const RENTER_ID = '22222222-2222-2222-2222-222222222222'
const MERCHANT_ID = '33333333-3333-3333-3333-333333333333'
const OTHER_ID = '44444444-4444-4444-4444-444444444444'
const PATH = `${BOOKING_ID}/${RENTER_ID}/pre_handover-1.jpg`

let ipCounter = 0
function req(body: unknown) {
  ipCounter += 1
  return new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.0.${ipCounter}` },
    body: JSON.stringify(body),
  })
}
function call(body: unknown) {
  return POST(req(body), { params: Promise.resolve({ id: BOOKING_ID }) })
}

const validBody = { storage_path: PATH, file_type: 'image' as const, evidence_stage: 'pre_handover' as const }

function bookingRow(overrides: Record<string, unknown> = {}) {
  return { id: BOOKING_ID, renter_id: RENTER_ID, merchant_id: MERCHANT_ID, status: 'accepted', ...overrides }
}

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: RENTER_ID, profile: {} })
  checkIdempotentReplay.mockReset().mockResolvedValue({ status: 'none' })
  cleanupUnregisteredUpload.mockReset().mockResolvedValue(undefined)
  fakeAsUserRows = []
  nextAdmin = fakeServiceRoleClient({
    bookings: { data: bookingRow() },
    booking_condition_evidence: { data: { id: 'row-1', storage_path: PATH, evidence_stage: 'pre_handover' } },
    idempotency_keys: { data: null },
  })
})

describe('POST /api/bookings/[id]/evidence (category: P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I)', () => {
  it('1. anonymous caller is rejected -- cleanup not called', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await call(validBody)
    expect(res.status).toBe(401)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('2. path-prefix mismatch is rejected before any DB call -- cleanup not called', async () => {
    const res = await call({ ...validBody, storage_path: 'not-my-booking/not-my-uid/file.jpg' })
    expect(res.status).toBe(403)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('3. invalid evidence_stage is rejected by schema validation', async () => {
    const res = await call({ ...validBody, evidence_stage: 'during_rental' })
    expect(res.status).toBe(400)
  })

  it('4. invalid file_type is rejected by schema validation', async () => {
    const res = await call({ ...validBody, file_type: 'pdf' })
    expect(res.status).toBe(400)
  })

  it('5. booking not found -- cleanup called, 404', async () => {
    nextAdmin = fakeServiceRoleClient({ bookings: { data: null } })
    const res = await call(validBody)
    expect(res.status).toBe(404)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
  })

  it('6. a user who is neither the renter nor the merchant on this booking is rejected -- cleanup called', async () => {
    getRequestProfile.mockResolvedValue({ userId: OTHER_ID, profile: {} })
    nextAdmin = fakeServiceRoleClient({ bookings: { data: bookingRow() } })
    const res = await call({ ...validBody, storage_path: `${BOOKING_ID}/${OTHER_ID}/pre_handover-1.jpg` })
    expect(res.status).toBe(403)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
  })

  it('7. the renter participant is accepted for pre_handover while accepted', async () => {
    const res = await call(validBody)
    expect(res.status).toBe(201)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('8. the merchant participant is accepted for pre_handover while accepted', async () => {
    getRequestProfile.mockResolvedValue({ userId: MERCHANT_ID, profile: {} })
    const merchantPath = `${BOOKING_ID}/${MERCHANT_ID}/pre_handover-1.jpg`
    const res = await call({ ...validBody, storage_path: merchantPath })
    expect(res.status).toBe(201)
  })

  it('9. pre_handover is rejected once the booking has reached return_pending -- cleanup called', async () => {
    nextAdmin = fakeServiceRoleClient({ bookings: { data: bookingRow({ status: 'return_pending' }) } })
    const res = await call(validBody)
    expect(res.status).toBe(409)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
  })

  it('10. post_return is rejected while the booking is still requested (before any handover)', async () => {
    nextAdmin = fakeServiceRoleClient({ bookings: { data: bookingRow({ status: 'requested' }) } })
    const path = `${BOOKING_ID}/${RENTER_ID}/post_return-1.jpg`
    const res = await call({ storage_path: path, file_type: 'image', evidence_stage: 'post_return' })
    expect(res.status).toBe(409)
  })

  it('11. post_return is accepted once the booking is disputed', async () => {
    nextAdmin = fakeServiceRoleClient({
      bookings: { data: bookingRow({ status: 'disputed' }) },
      booking_condition_evidence: { data: { id: 'row-2' } },
    })
    const path = `${BOOKING_ID}/${RENTER_ID}/post_return-1.jpg`
    const res = await call({ storage_path: path, file_type: 'image', evidence_stage: 'post_return' })
    expect(res.status).toBe(201)
  })

  it('12. a failed DB insert never reports success -- cleanup called, 500', async () => {
    nextAdmin = fakeServiceRoleClient({
      bookings: { data: bookingRow() },
      booking_condition_evidence: { data: null, error: { message: 'insert failed' } },
    })
    const res = await call(validBody)
    expect(res.status).toBe(500)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
    expect((await res.json()).error).not.toMatch(/insert failed/)
  })

  it('13. an idempotent replay returns the original result without creating a new row or calling cleanup', async () => {
    checkIdempotentReplay.mockResolvedValue({ status: 'replay', result: { id: 'original-row' } })
    const res = await call({ ...validBody, idempotency_key: 'retry-key-00000001' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'original-row' })
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('14. an idempotency-key conflict (same key, different request) is rejected -- cleanup called', async () => {
    checkIdempotentReplay.mockResolvedValue({ status: 'conflict' })
    const res = await call({ ...validBody, idempotency_key: 'retry-key-00000001' })
    expect(res.status).toBe(409)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
  })

  it('15. multiple distinct legitimate photos for the same stage are each accepted independently -- no single-photo-per-stage restriction', async () => {
    const pathA = `${BOOKING_ID}/${RENTER_ID}/pre_handover-1.jpg`
    const pathB = `${BOOKING_ID}/${RENTER_ID}/pre_handover-2.jpg`
    const resA = await call({ storage_path: pathA, file_type: 'image', evidence_stage: 'pre_handover' })
    const resB = await call({ storage_path: pathB, file_type: 'image', evidence_stage: 'pre_handover' })
    expect(resA.status).toBe(201)
    expect(resB.status).toBe(201)
  })

  it('16. the response never includes the raw internal insert error', async () => {
    nextAdmin = fakeServiceRoleClient({
      bookings: { data: bookingRow() },
      booking_condition_evidence: { data: null, error: { message: 'duplicate key value violates unique constraint' } },
    })
    const res = await call(validBody)
    const body = await res.json()
    expect(body.error).toBe('Could not register this evidence file')
  })
})

describe('GET /api/bookings/[id]/evidence (category: P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I)', () => {
  function getReq() {
    return new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/evidence`, { method: 'GET' })
  }
  function callGet() {
    return GET(getReq(), { params: Promise.resolve({ id: BOOKING_ID }) })
  }

  it('17. anonymous caller is rejected', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await callGet()
    expect(res.status).toBe(401)
  })

  it('18. a participant sees exactly what the RLS-scoped query returns (no re-filtering, no widening)', async () => {
    fakeAsUserRows = [{ id: 'row-1', evidence_stage: 'pre_handover' }, { id: 'row-2', evidence_stage: 'post_return' }]
    const res = await callGet()
    expect(res.status).toBe(200)
    expect((await res.json()).evidence).toHaveLength(2)
  })

  it('19. a non-participant (RLS-filtered empty result) sees no evidence rather than an error -- indistinguishable from "no evidence yet"', async () => {
    fakeAsUserRows = []
    const res = await callGet()
    expect(res.status).toBe(200)
    expect((await res.json()).evidence).toEqual([])
  })
})
