import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const checkIdempotentReplay = vi.fn()
vi.mock('@/lib/bookings/idempotency', () => ({ checkIdempotentReplay: (...args: unknown[]) => checkIdempotentReplay(...args) }))

const cleanupUnregisteredUpload = vi.fn()
vi.mock('@/lib/storage-cleanup', () => ({ cleanupUnregisteredUpload: (...args: unknown[]) => cleanupUnregisteredUpload(...args) }))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

const AGREEMENT_ID = '44444444-4444-4444-4444-444444444444'
const MILESTONE_ID = '55555555-5555-5555-5555-555555555555'
const OFFER_ITEM_ID = '66666666-6666-6666-6666-666666666666'
const ACCEPTED_OFFER_ID = '77777777-7777-7777-7777-777777777777'
const USER_ID = '22222222-2222-2222-2222-222222222222'
const PATH = `${MILESTONE_ID}/${USER_ID}/evidence-1.jpg`

let ipCounter = 0
function req(body: unknown) {
  ipCounter += 1
  return new NextRequest(`http://localhost/api/barter/${AGREEMENT_ID}/milestones/${MILESTONE_ID}/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.2.${ipCounter}` },
    body: JSON.stringify(body),
  })
}
function call(body: unknown) {
  return POST(req(body), { params: Promise.resolve({ id: AGREEMENT_ID, milestoneId: MILESTONE_ID }) })
}

const validBody = { storage_path: PATH, file_type: 'image' as const }

function baseTables(overrides: Record<string, { data: unknown; error?: unknown }> = {}) {
  return {
    barter_contribution_milestones: { data: { id: MILESTONE_ID, offer_item_id: OFFER_ITEM_ID, status: 'active' } },
    barter_agreements: { data: { party_a_id: USER_ID, accepted_offer_id: ACCEPTED_OFFER_ID } },
    barter_offer_items: { data: { offer_id: ACCEPTED_OFFER_ID } },
    barter_milestone_evidence: { data: { id: 'row-1', storage_path: PATH } },
    barter_milestone_history: { data: null },
    idempotency_keys: { data: null },
    ...overrides,
  }
}

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: USER_ID, profile: {} })
  checkIdempotentReplay.mockReset().mockResolvedValue({ status: 'ok' })
  cleanupUnregisteredUpload.mockReset().mockResolvedValue(undefined)
  nextAdmin = fakeServiceRoleClient(baseTables(), { is_barter_contribution_participant: { data: true } })
})

describe('POST /api/barter/[id]/milestones/[milestoneId]/evidence -- cleanup sequencing (category: Orphan Cleanup Phase A)', () => {
  it('A. unauthenticated (before path validation) -- cleanup NOT called', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await call(validBody)
    expect(res.status).toBe(401)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('B. path-prefix mismatch -- cleanup NOT called', async () => {
    const res = await call({ ...validBody, storage_path: 'not-my-milestone/not-my-uid/file.jpg' })
    expect(res.status).toBe(403)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('C. post-boundary semantic rejection (milestone not in accepted offer) -- cleanup called with correct params', async () => {
    nextAdmin = fakeServiceRoleClient(
      baseTables({ barter_offer_items: { data: { offer_id: 'some-other-superseded-offer' } } }),
      { is_barter_contribution_participant: { data: true } }
    )
    const res = await call(validBody)
    expect(res.status).toBe(409)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledWith(expect.objectContaining({
      bucket: 'barter-milestone-evidence',
      storagePath: PATH,
      metadataTable: 'barter_milestone_evidence',
      metadataPathColumn: 'storage_path',
      domain: 'barter-milestone-evidence',
    }))
  })

  it('C2. post-boundary DB insert failure -- cleanup called', async () => {
    nextAdmin = fakeServiceRoleClient(
      baseTables({ barter_milestone_evidence: { data: null, error: { message: 'insert failed' } } }),
      { is_barter_contribution_participant: { data: true } }
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
