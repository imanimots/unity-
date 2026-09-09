import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@/lib/admin/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/route-helpers')>()
  return { ...actual, getAdminServiceClient: () => Promise.resolve(nextAdmin) }
})

const { POST } = await import('../route')

const USER_ID = '22222222-2222-2222-2222-222222222222'
const TABLE = 'kyc_document_upload_intents'

const validBody = { document_type: 'identity_document' as const, mime_type: 'image/jpeg' as const, file_size: 12345 }
const insertedRow = { id: 'intent-1', storage_path: `${USER_ID}/identity_document/33333333-3333-3333-3333-333333333333.jpg`, expires_at: '2026-09-09T06:00:00Z' }

let ipCounter = 0
function req(body: unknown) {
  ipCounter += 1
  return new NextRequest('http://localhost/api/verification/documents/intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.5.${ipCounter}` },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: USER_ID, profile: {} })
  nextAdmin = fakeServiceRoleClient({ [TABLE]: { data: insertedRow } })
})

describe('POST /api/verification/documents/intents (category: KYC Orphan Cleanup Phase B3A)', () => {
  it('A. anonymous -> 401', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await POST(req(validBody))
    expect(res.status).toBe(401)
  })

  it('B. bad document_type -> reject', async () => {
    const res = await POST(req({ ...validBody, document_type: 'passport' }))
    expect(res.status).toBe(400)
  })

  it('C. bad mime_type -> reject', async () => {
    const res = await POST(req({ ...validBody, mime_type: 'image/gif' }))
    expect(res.status).toBe(400)
  })

  it('D. zero file_size -> reject', async () => {
    const res = await POST(req({ ...validBody, file_size: 0 }))
    expect(res.status).toBe(400)
  })

  it('E. oversize file_size -> reject', async () => {
    const res = await POST(req({ ...validBody, file_size: 10485761 }))
    expect(res.status).toBe(400)
  })

  it('F. valid request -> 201, service-role insert', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(201)
    expect(nextAdmin.from).toHaveBeenCalledWith(TABLE)
  })

  it('G/H. path is generated server-side and belongs to the authenticated caller', async () => {
    const res = await POST(req(validBody))
    const body = await res.json()
    expect(body.storage_path).toBe(insertedRow.storage_path)
    expect(body.storage_path.startsWith(`${USER_ID}/`)).toBe(true)
  })

  it('I. request cannot supply storage_path -- extra field is ignored, not trusted', async () => {
    const res = await POST(req({ ...validBody, storage_path: 'some/other/path.jpg' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    // The response is still the server-generated path, never the
    // client-supplied one -- the schema itself doesn't even have a
    // storage_path field, so an extra one is simply dropped by zod.
    expect(body.storage_path).toBe(insertedRow.storage_path)
  })

  it('J. request cannot supply user_id -- schema has no such field, session identity is the only source', async () => {
    // documentUploadIntentCreateSchema has no user_id field at all -- an
    // extra one in the body is simply dropped by zod; the route's own
    // source hardcodes `user_id: requester.userId` on insert (never a
    // request field), asserted structurally by this same file's schema.
    const res = await POST(req({ ...validBody, user_id: '99999999-9999-9999-9999-999999999999' }))
    expect(res.status).toBe(201)
  })

  it('K. rate limited', async () => {
    const rateLimitedReq = () =>
      new NextRequest('http://localhost/api/verification/documents/intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.9.5.999' },
        body: JSON.stringify(validBody),
      })
    let lastStatus = 201
    for (let i = 0; i < 11; i++) {
      const res = await POST(rateLimitedReq())
      lastStatus = res.status
    }
    expect(lastStatus).toBe(429)
  })

  it('malicious request cannot make expires_at/status/storage_path/user_id authoritative (category: KYC B3A final pre-commit gate)', async () => {
    const maliciousBody = {
      ...validBody,
      expires_at: '2099-01-01T00:00:00Z',
      status: 'finalized',
      storage_path: 'attacker-chosen/path.jpg',
      user_id: '99999999-9999-9999-9999-999999999999',
    }
    const res = await POST(req(maliciousBody))
    expect(res.status).toBe(201)

    const chain = nextAdmin.from.mock.results[0]?.value as { insert: ReturnType<typeof import('vitest').vi.fn> }
    expect(chain.insert).toHaveBeenCalledTimes(1)
    const insertPayload = chain.insert.mock.calls[0][0] as Record<string, unknown>

    // Every authoritative field the insert actually sends is
    // server-computed, never copied from the request body.
    expect(insertPayload.user_id).toBe(USER_ID) // the authenticated session's own id, not the attacker's
    expect(insertPayload.storage_path).not.toBe('attacker-chosen/path.jpg')
    expect(insertPayload.storage_path).toMatch(new RegExp(`^${USER_ID}/identity_document/`))
    expect(insertPayload.expires_at).not.toBe('2099-01-01T00:00:00Z')
    expect(insertPayload).not.toHaveProperty('status') // column DEFAULT 'pending' governs, route never sets it explicitly
  })

  it('L. safe DB failure error -- no raw Postgres text', async () => {
    nextAdmin = fakeServiceRoleClient({ [TABLE]: { data: null, error: { message: 'duplicate key value violates unique constraint "kyc_document_upload_intents_storage_path_key"' } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toMatch(/constraint|duplicate key|postgres/i)
  })
})
