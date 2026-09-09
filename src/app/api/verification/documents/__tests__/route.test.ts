import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeServiceRoleClient } from '@/app/api/__tests__/fake-service-role-client'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fake-anon-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const cleanupUnregisteredUpload = vi.fn()
vi.mock('@/lib/storage-cleanup', () => ({ cleanupUnregisteredUpload: (...args: unknown[]) => cleanupUnregisteredUpload(...args) }))

// ── Admin (service-role) client -- only ever used by this route for
// storage.from(bucket).info(), plus (mocked away above) cleanup. Reused
// from the shared Phase A fake's new optional `storageResponses` param.
let nextAdmin: ReturnType<typeof fakeServiceRoleClient>
vi.mock('@/lib/admin/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/route-helpers')>()
  return { ...actual, getAdminServiceClient: () => Promise.resolve(nextAdmin) }
})

// ── Session-bound (RLS) client -- the real write/read authority for
// this route (insert never uses service role, per the approved design).
// A single table (identity_verification_documents) is used for BOTH an
// existing-row lookup (array, resolved via a plain awaited query) and,
// on a genuinely new path, an insert (single row, resolved via
// .select().single()) -- the shared Phase A fake can't express two
// different responses for one table name, so this route gets its own
// small local fake that distinguishes the two by whether .insert() was
// called on that specific chain instance.
interface SessionTableConfig {
  existing?: { data: unknown; error?: unknown }
  afterInsert?: { data: unknown; error?: unknown }
}
let insertCallCount = 0
function fakeSessionClient(tables: Record<string, SessionTableConfig>) {
  function makeChain(config: SessionTableConfig) {
    let insertCalled = false
    const existing = { data: config.existing?.data ?? [], error: config.existing?.error ?? null }
    const afterInsert = { data: config.afterInsert?.data ?? null, error: config.afterInsert?.error ?? null }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      insert: () => {
        insertCalled = true
        insertCallCount += 1
        return chain
      },
      single: () => Promise.resolve(insertCalled ? afterInsert : existing),
      maybeSingle: () => Promise.resolve(insertCalled ? afterInsert : existing),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(existing).then(resolve, reject),
    }
    return chain
  }
  const from = vi.fn((table: string) => makeChain(tables[table] ?? {}))
  return { from }
}
let nextSession: ReturnType<typeof fakeSessionClient> | null
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(nextSession) }))

const { POST } = await import('../route')

const USER_ID = '22222222-2222-2222-2222-222222222222'
const OTHER_USER_ID = '99999999-9999-9999-9999-999999999999'
const LEAF_UUID = '33333333-3333-3333-3333-333333333333'
const PATH = `${USER_ID}/identity_document/${LEAF_UUID}.jpg`
const TABLE = 'identity_verification_documents'
const BUCKET = 'kyc-documents'

const validBody = { document_type: 'identity_document' as const, storage_path: PATH, mime_type: 'image/jpeg' as const, file_size: 12345 }
const registeredRow = { id: 'row-1', document_type: 'identity_document', storage_path: PATH, mime_type: 'image/jpeg', file_size: 12345, uploaded_at: '2026-09-09T00:00:00Z' }
const objectPresentMatching = { data: { contentType: 'image/jpeg', size: 12345 }, error: null }

function req(body: unknown) {
  return new NextRequest('http://localhost/api/verification/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: USER_ID, profile: {} })
  cleanupUnregisteredUpload.mockReset().mockResolvedValue(undefined)
  insertCallCount = 0
  nextAdmin = fakeServiceRoleClient({}, {}, { [BUCKET]: objectPresentMatching })
  nextSession = fakeSessionClient({ [TABLE]: { existing: { data: [] } } })
})

describe('POST /api/verification/documents (category: KYC Orphan Cleanup Phase B1)', () => {
  // ── Pre-T2 -- no cleanup possible or attempted for any of these. ──
  it('A. unauthenticated -> 401, no insert, no cleanup', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await POST(req(validBody))
    expect(res.status).toBe(401)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('B. malformed JSON body -> 400, no insert, no cleanup', async () => {
    const res = await POST(req('not json'))
    expect(res.status).toBe(400)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('C. cross-user path -> deny, no insert, no cleanup', async () => {
    const res = await POST(req({ ...validBody, storage_path: `${OTHER_USER_ID}/identity_document/${LEAF_UUID}.jpg` }))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('D. `..` traversal path -> deny, no insert, no cleanup', async () => {
    const res = await POST(req({ ...validBody, storage_path: `${USER_ID}/../identity_document/${LEAF_UUID}.jpg` }))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('E. extra path segment -> deny, no insert, no cleanup', async () => {
    const res = await POST(req({ ...validBody, storage_path: `${USER_ID}/identity_document/extra/${LEAF_UUID}.jpg` }))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('F. malformed UUID filename -> deny, no insert, no cleanup', async () => {
    const res = await POST(req({ ...validBody, storage_path: `${USER_ID}/identity_document/not-a-uuid.jpg` }))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('G. document-type/path mismatch -> deny, no insert, no cleanup', async () => {
    const res = await POST(req({ ...validBody, storage_path: `${USER_ID}/proof_of_address/${LEAF_UUID}.jpg` }))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('MIME/extension inconsistency -> deny, no insert, no cleanup', async () => {
    // Path says .jpg but the claimed mime_type is PNG.
    const res = await POST(req({ ...validBody, mime_type: 'image/png' }))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  // ── T2 established from here on. ──
  it('H. valid new path + Storage object present and matching -> 201, no cleanup', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(201)
    expect(insertCallCount).toBe(1)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('I. same path + same effective metadata replay -> existing row returned, insert NOT called, cleanup NOT called', async () => {
    nextSession = fakeSessionClient({ [TABLE]: { existing: { data: [registeredRow] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('row-1')
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('J. same path + conflicting metadata -> 409, insert NOT called, cleanup NOT called', async () => {
    nextSession = fakeSessionClient({ [TABLE]: { existing: { data: [{ ...registeredRow, file_size: 999 }] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(409)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('K. valid unregistered path, insert fails -> guarded cleanup invoked with correct params', async () => {
    nextSession = fakeSessionClient({
      [TABLE]: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'insert failed' } } },
    })
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: BUCKET, storagePath: PATH, metadataTable: TABLE, metadataPathColumn: 'storage_path', domain: 'kyc-documents' })
    )
  })

  it('L. insert error but the shared cleanup helper is trusted to guard registered-path races (not re-tested here, see storage-cleanup.test.ts)', async () => {
    // This route always delegates the fresh registered-path recheck to
    // cleanupUnregisteredUpload itself (Phase A's own proven guard) --
    // it never re-implements that check locally. Proven here only as
    // "cleanup was invoked, with the exact params that let the helper's
    // own guard do its job" -- same assertion as K.
    nextSession = fakeSessionClient({
      [TABLE]: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'insert failed' } } },
    })
    await POST(req(validBody))
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
  })

  it('M. cleanup itself throws -> original safe registration-failure response is preserved', async () => {
    cleanupUnregisteredUpload.mockRejectedValue(new Error('cleanup blew up'))
    nextSession = fakeSessionClient({
      [TABLE]: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'insert failed' } } },
    })
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toMatch(/insert failed/)
  })

  it('N. document A already registered, document B registration fails -> A untouched (only B is cleanup-eligible)', async () => {
    // Registering B (a different path/document_type) never touches A's
    // row -- cleanup is always scoped to exactly this request's own
    // validatedPath, never a broader per-user sweep.
    const pathB = `${USER_ID}/proof_of_address/44444444-4444-4444-4444-444444444444.pdf`
    nextSession = fakeSessionClient({
      [TABLE]: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'insert failed' } } },
    })
    nextAdmin = fakeServiceRoleClient({}, {}, { [BUCKET]: { data: { contentType: 'application/pdf', size: 500 }, error: null } })
    await POST(req({ document_type: 'proof_of_address', storage_path: pathB, mime_type: 'application/pdf', file_size: 500 }))
    expect(cleanupUnregisteredUpload).toHaveBeenCalledWith(expect.objectContaining({ storagePath: pathB }))
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalledWith(expect.objectContaining({ storagePath: PATH }))
  })

  it('O. failure responses never contain raw DB/Storage error text', async () => {
    nextSession = fakeSessionClient({
      [TABLE]: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'duplicate key value violates unique constraint "some_pg_constraint"' } } },
    })
    const res = await POST(req(validBody))
    const body = await res.json()
    expect(body.error).not.toMatch(/constraint|duplicate key|postgres/i)
  })

  // ── Storage-object integrity (new to Phase B1's amended design). ──
  it('P. syntactically valid path but Storage object does not exist -> 404, no insert, no cleanup', async () => {
    nextAdmin = fakeServiceRoleClient({}, {}, { [BUCKET]: { data: null, error: { status: 404, message: 'not found' } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(404)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('Q. Storage existence lookup fails ambiguously -> fail closed, no insert, no cleanup', async () => {
    nextAdmin = fakeServiceRoleClient({}, {}, { [BUCKET]: { data: null, error: { status: 500, message: 'upstream unavailable' } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('R. object exists and matches -> registration proceeds', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(201)
  })

  it('S. actual Storage content-type mismatches the claim -> reject before insert, no cleanup', async () => {
    nextAdmin = fakeServiceRoleClient({}, {}, { [BUCKET]: { data: { contentType: 'application/pdf', size: 12345 }, error: null } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('T. actual Storage size mismatches the claim -> reject before insert, no cleanup', async () => {
    nextAdmin = fakeServiceRoleClient({}, {}, { [BUCKET]: { data: { contentType: 'image/jpeg', size: 999 }, error: null } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  // ── Multiple-row replay handling (no uniqueness constraint exists). ──
  it('U. multiple existing rows, all identical effective metadata -> 200 idempotent success, no insert, no cleanup', async () => {
    nextSession = fakeSessionClient({ [TABLE]: { existing: { data: [registeredRow, { ...registeredRow, id: 'row-2' }] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(200)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('V. multiple existing rows, any one conflicting -> 409, no insert, no cleanup', async () => {
    nextSession = fakeSessionClient({
      [TABLE]: { existing: { data: [registeredRow, { ...registeredRow, id: 'row-2', file_size: 1 }] } },
    })
    const res = await POST(req(validBody))
    expect(res.status).toBe(409)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })
})
