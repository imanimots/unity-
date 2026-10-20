import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const createServerClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: (...args: unknown[]) => createServerClient(...args) }))

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }))

const getBookingConditionEvidenceSignedUrl = vi.fn()
vi.mock('@/lib/bookings/evidence-access', () => ({
  getBookingConditionEvidenceSignedUrl: (...args: unknown[]) => getBookingConditionEvidenceSignedUrl(...args),
}))

const { POST } = await import('../route')

const BOOKING_ID = '11111111-1111-1111-1111-111111111111'
const EVIDENCE_ID = '22222222-2222-2222-2222-222222222222'

let ipCounter = 0
function call() {
  ipCounter += 1
  const request = new NextRequest(`http://localhost/api/bookings/${BOOKING_ID}/evidence/${EVIDENCE_ID}/access`, {
    method: 'POST',
    headers: { 'x-forwarded-for': `10.9.1.${ipCounter}` },
  })
  return POST(request, { params: Promise.resolve({ id: BOOKING_ID, evidenceId: EVIDENCE_ID }) })
}

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: 'user-1', profile: {} })
  createServerClient.mockReset().mockResolvedValue({})
  getBookingConditionEvidenceSignedUrl.mockReset().mockResolvedValue({ url: 'https://signed.example/x', expiresAt: new Date(Date.now() + 120_000).toISOString() })
})

describe('POST /api/bookings/[id]/evidence/[evidenceId]/access (category: P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I)', () => {
  it('1. rejects an invalid booking id without calling the signer', async () => {
    const request = new NextRequest(`http://localhost/api/bookings/not-a-uuid/evidence/${EVIDENCE_ID}/access`, { method: 'POST' })
    const res = await POST(request, { params: Promise.resolve({ id: 'not-a-uuid', evidenceId: EVIDENCE_ID }) })
    expect(res.status).toBe(400)
    expect(getBookingConditionEvidenceSignedUrl).not.toHaveBeenCalled()
  })

  it('2. rejects an anonymous caller', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(getBookingConditionEvidenceSignedUrl).not.toHaveBeenCalled()
  })

  it('3. returns 404 when the underlying lookup reports evidence_not_found (covers both "genuinely missing" and "RLS denied" -- same response either way, never leaking which)', async () => {
    getBookingConditionEvidenceSignedUrl.mockRejectedValue(new Error('evidence_not_found'))
    const res = await call()
    expect(res.status).toBe(404)
  })

  it('4. returns the signed URL on success', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe('https://signed.example/x')
  })

  it('5. returns a safe generic 500 for an unexpected signing failure, never the raw error', async () => {
    getBookingConditionEvidenceSignedUrl.mockRejectedValue(new Error('could_not_sign_url'))
    const res = await call()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Could not generate a secure evidence link')
  })
})
