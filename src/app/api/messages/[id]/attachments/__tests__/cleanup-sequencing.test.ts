import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const checkIdempotentReplay = vi.fn()
vi.mock('@/lib/messaging/idempotency', () => ({
  checkIdempotentReplay: (...args: unknown[]) => checkIdempotentReplay(...args),
  computeRegisterAttachmentHash: () => 'fake-hash',
}))

const cleanupUnregisteredUpload = vi.fn()
vi.mock('@/lib/storage-cleanup', () => ({ cleanupUnregisteredUpload: (...args: unknown[]) => cleanupUnregisteredUpload(...args) }))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

const MESSAGE_ID = '88888888-8888-8888-8888-888888888888'
const BOOKING_ID = '99999999-9999-9999-9999-999999999999'
const USER_ID = '22222222-2222-2222-2222-222222222222'
const PATH = `booking/${BOOKING_ID}/${USER_ID}/attachment-1.jpg`

let ipCounter = 0
function req(body: unknown) {
  ipCounter += 1
  return new NextRequest(`http://localhost/api/messages/${MESSAGE_ID}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.3.${ipCounter}` },
    body: JSON.stringify(body),
  })
}
function call(body: unknown) {
  return POST(req(body), { params: Promise.resolve({ id: MESSAGE_ID }) })
}

const validBody = { storage_path: PATH, file_type: 'image' as const }

function baseTables(overrides: Record<string, { data: unknown; error?: unknown; count?: number }> = {}) {
  return {
    messages: { data: { id: MESSAGE_ID, booking_id: BOOKING_ID, order_id: null, barter_agreement_id: null } },
    message_attachments: { data: { id: 'row-1', storage_path: PATH }, count: 0 },
    idempotency_keys: { data: null },
    ...overrides,
  }
}

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: USER_ID, profile: {} })
  checkIdempotentReplay.mockReset().mockResolvedValue({ status: 'ok' })
  cleanupUnregisteredUpload.mockReset().mockResolvedValue(undefined)
  nextAdmin = fakeServiceRoleClient(baseTables(), { is_message_participant: { data: true } })
})

describe('POST /api/messages/[id]/attachments -- cleanup sequencing (category: Orphan Cleanup Phase A)', () => {
  // ── Pre-T2: path validation happens LATE in this route (after the
  // message lookup resolves the thread type/id needed to compute the
  // expected prefix), so these three failures never have a validated
  // path in scope and must never attempt cleanup. ──
  it('A1. unauthenticated (before any lookup) -- cleanup NOT called', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await call(validBody)
    expect(res.status).toBe(401)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('A2. message not found (before path validation in this route) -- cleanup NOT called', async () => {
    nextAdmin = fakeServiceRoleClient(baseTables({ messages: { data: null } }), { is_message_participant: { data: true } })
    const res = await call(validBody)
    expect(res.status).toBe(404)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('A3. not a participant (before path validation in this route) -- cleanup NOT called', async () => {
    nextAdmin = fakeServiceRoleClient(baseTables(), { is_message_participant: { data: false } })
    const res = await call(validBody)
    expect(res.status).toBe(403)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('A4. early idempotency conflict (before path validation in this route) -- cleanup NOT called', async () => {
    checkIdempotentReplay.mockResolvedValue({ status: 'conflict' })
    const res = await call({ ...validBody, idempotency_key: 'a-conflict-test-key' })
    expect(res.status).toBe(409)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('B. path-prefix mismatch -- cleanup NOT called', async () => {
    const res = await call({ ...validBody, storage_path: `booking/${BOOKING_ID}/not-my-uid/file.jpg` })
    expect(res.status).toBe(403)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('C. post-boundary attachment-count-cap failure -- cleanup called with correct params', async () => {
    nextAdmin = fakeServiceRoleClient(baseTables({ message_attachments: { data: null, count: 4 } }), { is_message_participant: { data: true } })
    const res = await call(validBody)
    expect(res.status).toBe(409)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledWith(expect.objectContaining({
      bucket: 'chat-attachments',
      storagePath: PATH,
      metadataTable: 'message_attachments',
      metadataPathColumn: 'storage_path',
      domain: 'chat-attachments',
    }))
  })

  it('C2. post-boundary DB insert failure (non-23505) -- cleanup called', async () => {
    nextAdmin = fakeServiceRoleClient(
      baseTables({ message_attachments: { data: null, error: { message: 'insert failed', code: '55000' }, count: 0 } }),
      { is_message_participant: { data: true } }
    )
    const res = await call(validBody)
    expect(res.status).toBe(500)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
  })

  it('E. 23505 unique-violation insert failure -- cleanup NOT called (this exact path is definitionally already registered -- see route comment + message_attachments_message_path_uniq)', async () => {
    nextAdmin = fakeServiceRoleClient(
      baseTables({ message_attachments: { data: null, error: { message: 'duplicate key', code: '23505' }, count: 0 } }),
      { is_message_participant: { data: true } }
    )
    const res = await call(validBody)
    expect(res.status).toBe(409)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('D. successful registration -- cleanup NOT called', async () => {
    const res = await call(validBody)
    expect(res.status).toBe(201)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })
})
