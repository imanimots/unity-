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
vi.mock('@/lib/rent-to-buy/idempotency', () => ({
  checkIdempotentReplay: (...args: unknown[]) => checkIdempotentReplay(...args),
  computeRegisterRentToBuyEvidenceHash: () => 'fake-hash',
}))

const cleanupUnregisteredUpload = vi.fn()
vi.mock('@/lib/storage-cleanup', () => ({ cleanupUnregisteredUpload: (...args: unknown[]) => cleanupUnregisteredUpload(...args) }))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

const AGREEMENT_ID = '11111111-1111-1111-1111-111111111111'
const USER_ID = '22222222-2222-2222-2222-222222222222'
const PATH = `${AGREEMENT_ID}/${USER_ID}/pre_handover-1.jpg`

let ipCounter = 0
function req(body: unknown) {
  ipCounter += 1
  return new NextRequest(`http://localhost/api/rent-to-buy/agreements/${AGREEMENT_ID}/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.0.${ipCounter}` },
    body: JSON.stringify(body),
  })
}
function call(body: unknown) {
  return POST(req(body), { params: Promise.resolve({ id: AGREEMENT_ID }) })
}

const validBody = { storage_path: PATH, file_type: 'image' as const, evidence_type: 'pre_handover' as const }

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: USER_ID, profile: {} })
  checkIdempotentReplay.mockReset().mockResolvedValue({ status: 'ok' })
  cleanupUnregisteredUpload.mockReset().mockResolvedValue(undefined)
  nextAdmin = fakeServiceRoleClient({
    rent_to_buy_agreements: { data: { id: AGREEMENT_ID, merchant_id: USER_ID, customer_id: 'other-user' } },
    rent_to_buy_evidence: { data: { id: 'row-1', storage_path: PATH } },
    idempotency_keys: { data: null },
  })
})

describe('POST /api/rent-to-buy/agreements/[id]/evidence -- cleanup sequencing (category: Orphan Cleanup Phase A)', () => {
  it('A. unauthenticated (before path validation) -- cleanup NOT called', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await call(validBody)
    expect(res.status).toBe(401)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('B. path-prefix mismatch -- cleanup NOT called', async () => {
    const res = await call({ ...validBody, storage_path: 'not-my-agreement/not-my-uid/file.jpg' })
    expect(res.status).toBe(403)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('C. post-boundary semantic rejection (wrong evidence type for role) -- cleanup called with correct params', async () => {
    // USER_ID is the merchant here, not the customer -- post_handover_receipt requires the customer.
    const res = await call({ ...validBody, evidence_type: 'post_handover_receipt' })
    expect(res.status).toBe(403)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledWith(expect.objectContaining({
      bucket: 'rent-to-buy-evidence',
      storagePath: PATH,
      metadataTable: 'rent_to_buy_evidence',
      metadataPathColumn: 'storage_path',
      domain: 'rent-to-buy-evidence',
    }))
  })

  it('C2. post-boundary DB insert failure -- cleanup called', async () => {
    nextAdmin = fakeServiceRoleClient({
      rent_to_buy_agreements: { data: { id: AGREEMENT_ID, merchant_id: USER_ID, customer_id: 'other-user' } },
      rent_to_buy_evidence: { data: null, error: { message: 'insert failed' } },
    })
    const res = await call(validBody)
    expect(res.status).toBe(500)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
  })

  it('D. successful registration -- cleanup NOT called', async () => {
    const res = await call(validBody)
    expect(res.status).toBe(201)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })
})
