import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const checkIdempotentReplay = vi.fn()
vi.mock('@/lib/disputes/idempotency', () => ({
  checkIdempotentReplay: (...args: unknown[]) => checkIdempotentReplay(...args),
  computeRegisterDisputeEvidenceHash: () => 'fake-hash',
}))

vi.mock('@/lib/disputes/notify', () => ({ notifyDisputeParties: vi.fn().mockResolvedValue(undefined) }))

const cleanupUnregisteredUpload = vi.fn()
vi.mock('@/lib/storage-cleanup', () => ({ cleanupUnregisteredUpload: (...args: unknown[]) => cleanupUnregisteredUpload(...args) }))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

const DISPUTE_ID = '33333333-3333-3333-3333-333333333333'
const USER_ID = '22222222-2222-2222-2222-222222222222'
const PATH = `${DISPUTE_ID}/${USER_ID}/evidence-1.jpg`

let ipCounter = 0
function req(body: unknown) {
  ipCounter += 1
  return new NextRequest(`http://localhost/api/disputes/${DISPUTE_ID}/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.1.${ipCounter}` },
    body: JSON.stringify(body),
  })
}
function call(body: unknown) {
  return POST(req(body), { params: Promise.resolve({ id: DISPUTE_ID }) })
}

const validBody = { storage_path: PATH, file_type: 'image' as const }

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: USER_ID, profile: {} })
  checkIdempotentReplay.mockReset().mockResolvedValue({ status: 'ok' })
  cleanupUnregisteredUpload.mockReset().mockResolvedValue(undefined)
  nextAdmin = fakeServiceRoleClient(
    {
      disputes: { data: { id: DISPUTE_ID, raised_by: USER_ID, status: 'open' } },
      dispute_evidence: { data: { id: 'row-1', storage_path: PATH } },
      dispute_history: { data: null },
      idempotency_keys: { data: null },
    },
    { is_dispute_participant: { data: true } }
  )
})

describe('POST /api/disputes/[id]/evidence -- cleanup sequencing (category: Orphan Cleanup Phase A)', () => {
  it('A. unauthenticated (before path validation) -- cleanup NOT called', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await call(validBody)
    expect(res.status).toBe(401)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('B. path-prefix mismatch -- cleanup NOT called', async () => {
    const res = await call({ ...validBody, storage_path: 'not-my-dispute/not-my-uid/file.jpg' })
    expect(res.status).toBe(403)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('C. post-boundary semantic rejection (dispute no longer active) -- cleanup called with correct params', async () => {
    nextAdmin = fakeServiceRoleClient(
      { disputes: { data: { id: DISPUTE_ID, raised_by: USER_ID, status: 'resolved' } } },
      { is_dispute_participant: { data: true } }
    )
    const res = await call(validBody)
    expect(res.status).toBe(409)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledWith(expect.objectContaining({
      bucket: 'dispute-evidence',
      storagePath: PATH,
      metadataTable: 'dispute_evidence',
      metadataPathColumn: 'storage_path',
      domain: 'dispute-evidence',
    }))
  })

  it('C2. post-boundary DB insert failure -- cleanup called', async () => {
    nextAdmin = fakeServiceRoleClient(
      {
        disputes: { data: { id: DISPUTE_ID, raised_by: USER_ID, status: 'open' } },
        dispute_evidence: { data: null, error: { message: 'insert failed' } },
      },
      { is_dispute_participant: { data: true } }
    )
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
