import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fake-anon-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const cleanupUnregisteredUpload = vi.fn()
vi.mock('@/lib/storage-cleanup', () => ({ cleanupUnregisteredUpload: (...args: unknown[]) => cleanupUnregisteredUpload(...args) }))

// ── One chainable fake covering everything both branches of this route
// touch: `.from(table)` (a lookup resolved via a plain awaited query, and
// an insert resolved via .select().single() -- distinguished per chain
// instance by whether .insert() was called, so a single table name can
// return an "existing rows" array and a different "after insert" row),
// `.rpc()` (the NEW intent branch), and `.storage.from(bucket).info()`
// (the legacy branch's Storage existence check).
//
// B2L: the legacy branch now performs ALL of its DB work -- the
// kyc_document_upload_intents gate lookup, the existing-row lookup, and
// the final insert -- through the service-role (`admin`) client, since
// the "identity_verification_documents: owner insert" RLS policy is
// dropped. So `nextAdmin` is the legacy branch's authority; `nextSession`
// now matters only for the NEW branch's `.rpc()`.
interface ChainTableConfig {
  existing?: { data: unknown; error?: unknown }
  afterInsert?: { data: unknown; error?: unknown }
}
let insertCallCount = 0
let nextRpcResponse: { data: unknown; error: { message: string } | null } = { data: null, error: null }
// B3M -- the legacy branch's own durable-metric RPC response, kept
// independent from `nextRpcResponse` (the NEW/intent branch's RPC)
// since both branches' fakes share this module's `rpc()` shape but
// must be controllable separately in tests.
let nextMetricRpcResponse: { data: unknown; error: { message: string } | null } = { data: null, error: null }
const METRIC_RPC = 'record_kyc_legacy_finalize_attempt'
// B3M -- records the exact sequence of fake-client operations across
// both `nextAdmin` and `nextSession` for one request, so the B2L-gate
// -> metric-RPC -> downstream-legacy-work ordering can be asserted
// directly rather than inferred from source position alone.
let callOrder: string[] = []

function fakeChainClient(
  tables: Record<string, ChainTableConfig>,
  storageResponses: Record<string, { data: unknown; error?: unknown }> = {}
) {
  function makeChain(config: ChainTableConfig, table: string) {
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
        callOrder.push(`insert:${table}`)
        return chain
      },
      single: () => Promise.resolve(insertCalled ? afterInsert : existing),
      maybeSingle: () => Promise.resolve(insertCalled ? afterInsert : existing),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(existing).then(resolve, reject),
    }
    return chain
  }
  const from = vi.fn((table: string) => {
    callOrder.push(`from:${table}`)
    return makeChain(tables[table] ?? {}, table)
  })
  const rpc = vi.fn((name: string) => {
    callOrder.push(`rpc:${name}`)
    return Promise.resolve(name === METRIC_RPC ? nextMetricRpcResponse : nextRpcResponse)
  })
  const storageInfo = vi.fn((bucket: string) => {
    callOrder.push(`storage.info:${bucket}`)
    return Promise.resolve(storageResponses[bucket] ?? { data: null, error: { status: 404, message: 'not found' } })
  })
  const storage = { from: (bucket: string) => ({ info: () => storageInfo(bucket), remove: vi.fn(() => Promise.resolve({ data: null, error: null })) }) }
  return { from, rpc, storage }
}

let nextAdmin: ReturnType<typeof fakeChainClient>
let nextSession: ReturnType<typeof fakeChainClient> | null
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(nextSession) }))
vi.mock('@/lib/admin/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/route-helpers')>()
  return { ...actual, getAdminServiceClient: () => Promise.resolve(nextAdmin) }
})

const { POST } = await import('../route')

const USER_ID = '22222222-2222-2222-2222-222222222222'
const OTHER_USER_ID = '99999999-9999-9999-9999-999999999999'
const LEAF_UUID = '33333333-3333-3333-3333-333333333333'
const PATH = `${USER_ID}/identity_document/${LEAF_UUID}.jpg`
const TABLE = 'identity_verification_documents'
const INTENTS = 'kyc_document_upload_intents'
const BUCKET = 'kyc-documents'

const validBody = { document_type: 'identity_document' as const, storage_path: PATH, mime_type: 'image/jpeg' as const, file_size: 12345 }
const registeredRow = { id: 'row-1', document_type: 'identity_document', storage_path: PATH, mime_type: 'image/jpeg', file_size: 12345, uploaded_at: '2026-09-09T00:00:00Z' }
const objectPresentMatching = { data: { contentType: 'image/jpeg', size: 12345 }, error: null }

/** Legacy-branch admin fake: no owning intent, empty existing rows, a
 * successful insert, and a matching Storage object -- the "valid new
 * no-intent path" baseline. Individual tests override one slice. */
function legacyAdmin(over: { intents?: ChainTableConfig; docs?: ChainTableConfig; storage?: Record<string, { data: unknown; error?: unknown }> } = {}) {
  return fakeChainClient(
    {
      [INTENTS]: over.intents ?? { existing: { data: [] } },
      [TABLE]: over.docs ?? { existing: { data: [] }, afterInsert: { data: registeredRow } },
    },
    over.storage ?? { [BUCKET]: objectPresentMatching }
  )
}

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
  callOrder = []
  nextAdmin = legacyAdmin()
  nextSession = fakeChainClient({})
  nextRpcResponse = { data: null, error: null }
  nextMetricRpcResponse = { data: null, error: null }
})

describe('POST /api/verification/documents -- legacy branch (category: KYC Orphan Cleanup Phase B1 / B2L)', () => {
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

  it('C. cross-user path -> deny BEFORE the intent-existence lookup (no oracle), no insert, no cleanup', async () => {
    const res = await POST(req({ ...validBody, storage_path: `${OTHER_USER_ID}/identity_document/${LEAF_UUID}.jpg` }))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
    // The service-role client is fetched lazily inside the try block,
    // only reached after path ownership passes -- a 403 here means the
    // intent-existence lookup was never performed.
    expect(nextAdmin.from).not.toHaveBeenCalledWith(INTENTS)
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
    const res = await POST(req({ ...validBody, mime_type: 'image/png' }))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  // ── B2L intent gate ──
  it('B2L-1. exact path owned by an intent -> 409, no insert, no cleanup, no RPC (regardless of intent status: gate selects id only)', async () => {
    nextAdmin = legacyAdmin({ intents: { existing: { data: [{ id: 'intent-x' }] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(409)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
    expect(nextSession?.rpc).not.toHaveBeenCalled()
    // B3M: an intent-owned path never reaches the durable-metric
    // boundary -- it is rejected by the B2L gate itself.
    expect(nextAdmin.rpc).not.toHaveBeenCalledWith(METRIC_RPC)
  })

  it('B2L-2. intent-gate lookup itself errors -> fail closed (500), no insert, never treated as "no intent"', async () => {
    nextAdmin = legacyAdmin({ intents: { existing: { data: null, error: { message: 'connection reset' } } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.error).not.toMatch(/connection reset|postgres/i)
  })

  // ── T2 established, no owning intent -- B1 behaviour, now service-role authority. ──
  it('H. valid new no-intent path + Storage object present and matching -> 201 via service-role insert', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(201)
    expect(insertCallCount).toBe(1)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
    // The legacy branch no longer uses the session client at all.
    expect(nextSession?.rpc).not.toHaveBeenCalled()
  })

  it('I. same path + same effective metadata replay -> existing row returned, insert NOT called, cleanup NOT called (intent gate proven first)', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [registeredRow] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('row-1')
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('J. same path + conflicting metadata -> 409, insert NOT called, cleanup NOT called', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [{ ...registeredRow, file_size: 999 }] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(409)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('K. valid unregistered no-intent path, insert fails -> guarded cleanup invoked with correct params', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'insert failed' } } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledTimes(1)
    expect(cleanupUnregisteredUpload).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: BUCKET, storagePath: PATH, metadataTable: TABLE, metadataPathColumn: 'storage_path', domain: 'kyc-documents' })
    )
  })

  it('M. cleanup itself throws -> original safe registration-failure response is preserved', async () => {
    cleanupUnregisteredUpload.mockRejectedValue(new Error('cleanup blew up'))
    nextAdmin = legacyAdmin({ docs: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'insert failed' } } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toMatch(/insert failed/)
  })

  it('N. document A already registered, document B registration fails -> A untouched (only B is cleanup-eligible)', async () => {
    const pathB = `${USER_ID}/proof_of_address/44444444-4444-4444-4444-444444444444.pdf`
    nextAdmin = legacyAdmin({
      docs: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'insert failed' } } },
      storage: { [BUCKET]: { data: { contentType: 'application/pdf', size: 500 }, error: null } },
    })
    await POST(req({ document_type: 'proof_of_address', storage_path: pathB, mime_type: 'application/pdf', file_size: 500 }))
    expect(cleanupUnregisteredUpload).toHaveBeenCalledWith(expect.objectContaining({ storagePath: pathB }))
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalledWith(expect.objectContaining({ storagePath: PATH }))
  })

  it('O. failure responses never contain raw DB/Storage error text', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'duplicate key value violates unique constraint "some_pg_constraint"' } } } })
    const res = await POST(req(validBody))
    const body = await res.json()
    expect(body.error).not.toMatch(/constraint|duplicate key|postgres/i)
  })

  // ── Storage-object integrity (unchanged from B1). ──
  it('P. syntactically valid no-intent path but Storage object does not exist -> 404, no insert, no cleanup', async () => {
    nextAdmin = legacyAdmin({ storage: { [BUCKET]: { data: null, error: { status: 404, message: 'not found' } } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(404)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('Q. Storage existence lookup fails ambiguously -> fail closed, no insert, no cleanup', async () => {
    nextAdmin = legacyAdmin({ storage: { [BUCKET]: { data: null, error: { status: 500, message: 'upstream unavailable' } } } })
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
    nextAdmin = legacyAdmin({ storage: { [BUCKET]: { data: { contentType: 'application/pdf', size: 12345 }, error: null } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('T. actual Storage size mismatches the claim -> reject before insert, no cleanup', async () => {
    nextAdmin = legacyAdmin({ storage: { [BUCKET]: { data: { contentType: 'image/jpeg', size: 999 }, error: null } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  // ── Multiple-row replay handling (no uniqueness constraint exists). ──
  it('U. multiple existing rows, all identical effective metadata -> 200 idempotent success, no insert, no cleanup', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [registeredRow, { ...registeredRow, id: 'row-2' }] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(200)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })

  it('V. multiple existing rows, any one conflicting -> 409, no insert, no cleanup', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [registeredRow, { ...registeredRow, id: 'row-2', file_size: 1 }] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(409)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
  })
})

describe('POST /api/verification/documents -- dual-shape dispatch (category: KYC Orphan Cleanup Phase B3A)', () => {
  const INTENT_ID = '44444444-4444-4444-8444-444444444444'

  it('NEW-A. { intent_id } dispatches to the RPC branch, never the legacy path', async () => {
    nextRpcResponse = { data: registeredRow, error: null }
    const res = await POST(req({ intent_id: INTENT_ID }))
    expect(res.status).toBe(201)
    expect(nextSession?.rpc).toHaveBeenCalledWith('finalize_kyc_document_upload', { p_intent_id: INTENT_ID })
  })

  it('NEW-B. calls the RPC via the session-bound client', async () => {
    nextRpcResponse = { data: registeredRow, error: null }
    await POST(req({ intent_id: INTENT_ID }))
    expect(nextSession?.rpc).toHaveBeenCalledTimes(1)
  })

  it('NEW-C. never uses the service-role client to invoke the RPC', async () => {
    nextRpcResponse = { data: registeredRow, error: null }
    await POST(req({ intent_id: INTENT_ID }))
    expect(nextSession?.rpc).toHaveBeenCalled()
    expect(nextAdmin.rpc).not.toHaveBeenCalled()
  })

  it('NEW-D. safe success mapping -> 201 with the function\'s returned document', async () => {
    nextRpcResponse = { data: registeredRow, error: null }
    const res = await POST(req({ intent_id: INTENT_ID }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toEqual(registeredRow)
  })

  it('NEW-E. safe missing-object error mapping -> 404, no raw SQL text', async () => {
    nextRpcResponse = { data: null, error: { message: 'storage_object_missing' } }
    const res = await POST(req({ intent_id: INTENT_ID }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).not.toMatch(/storage_object_missing|P0001|PL\/pgSQL/i)
  })

  it('NEW-F. safe expired error mapping -> 409', async () => {
    nextRpcResponse = { data: null, error: { message: 'intent_expired' } }
    const res = await POST(req({ intent_id: INTENT_ID }))
    expect(res.status).toBe(409)
  })

  it('NEW-G. safe conflict mapping -> 409', async () => {
    nextRpcResponse = { data: null, error: { message: 'metadata_conflict' } }
    const res = await POST(req({ intent_id: INTENT_ID }))
    expect(res.status).toBe(409)
  })

  it('NEW-H. safe cross-user mapping -> 404, does not leak that the intent exists for someone else', async () => {
    nextRpcResponse = { data: null, error: { message: 'intent_not_found' } }
    const res = await POST(req({ intent_id: INTENT_ID }))
    expect(res.status).toBe(404)
  })

  it('NEW-I. safe mime/size mismatch mapping -> 403', async () => {
    nextRpcResponse = { data: null, error: { message: 'storage_metadata_mismatch' } }
    const res = await POST(req({ intent_id: INTENT_ID }))
    expect(res.status).toBe(403)
  })

  it('LEGACY-A. original B1 body is still accepted for a genuine no-intent path during B3A', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(201)
    expect(nextSession?.rpc).not.toHaveBeenCalled()
  })

  it('LEGACY-B. legacy Storage .info() check still governs the legacy branch', async () => {
    nextAdmin = legacyAdmin({ storage: { [BUCKET]: { data: null, error: { status: 404 } } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(404)
  })

  it('LEGACY-C. a known intent-backed path submitted through the legacy body is rejected (B2L)', async () => {
    nextAdmin = legacyAdmin({ intents: { existing: { data: [{ id: 'intent-x' }] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(409)
    expect(insertCallCount).toBe(0)
    expect(nextSession?.rpc).not.toHaveBeenCalled()
    expect(nextAdmin.rpc).not.toHaveBeenCalledWith(METRIC_RPC)
  })

  it('mixed intent + legacy body -> rejected, dispatched to neither branch', async () => {
    const res = await POST(req({ intent_id: INTENT_ID, document_type: 'identity_document', storage_path: PATH, mime_type: 'image/jpeg', file_size: 1 }))
    expect(res.status).toBe(400)
    expect(nextSession?.rpc).not.toHaveBeenCalled()
    expect(insertCallCount).toBe(0)
  })

  it('empty body -> rejected as invalid (matches neither shape)', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(nextSession?.rpc).not.toHaveBeenCalled()
  })
})

describe('POST /api/verification/documents -- B3M durable legacy-finalization metric (category: KYC Orphan Cleanup Phase B3M)', () => {
  const consoleLogSpy = () => vi.spyOn(console, 'log').mockImplementation(() => undefined)

  it('A. anonymous request -> recorder not called', async () => {
    getRequestProfile.mockResolvedValue(null)
    await POST(req(validBody))
    expect(nextAdmin.rpc).not.toHaveBeenCalledWith(METRIC_RPC)
  })

  it('B. malformed body -> recorder not called', async () => {
    await POST(req('not json'))
    expect(nextAdmin.rpc).not.toHaveBeenCalledWith(METRIC_RPC)
  })

  it('C. cross-user path -> recorder not called', async () => {
    await POST(req({ ...validBody, storage_path: `${OTHER_USER_ID}/identity_document/${LEAF_UUID}.jpg` }))
    expect(nextAdmin.rpc).not.toHaveBeenCalledWith(METRIC_RPC)
  })

  it('D. intent-owned path -> 409, recorder not called', async () => {
    nextAdmin = legacyAdmin({ intents: { existing: { data: [{ id: 'intent-x' }] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(409)
    expect(nextAdmin.rpc).not.toHaveBeenCalledWith(METRIC_RPC)
  })

  it('E. valid genuine no-intent fresh legacy request -> recorder called once', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(201)
    expect(nextAdmin.rpc).toHaveBeenCalledWith(METRIC_RPC)
    expect(nextAdmin.rpc).toHaveBeenCalledTimes(1)
  })

  it('F. same genuine legacy request replayed -> recorder called once for that request', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [registeredRow] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(200)
    expect(nextAdmin.rpc).toHaveBeenCalledWith(METRIC_RPC)
    expect(nextAdmin.rpc).toHaveBeenCalledTimes(1)
  })

  it('G. second replay request increments/calls the recorder again -- request-volume semantics, no dedup', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [registeredRow] } } })
    await POST(req(validBody))
    await POST(req(validBody))
    const metricCalls = nextAdmin.rpc.mock.calls.filter((c) => c[0] === METRIC_RPC)
    expect(metricCalls).toHaveLength(2)
  })

  it('H. metadata conflict downstream -> recorder already called before the conflict is detected', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [{ ...registeredRow, file_size: 999 }] } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(409)
    expect(nextAdmin.rpc).toHaveBeenCalledWith(METRIC_RPC)
  })

  it('I. Storage missing downstream -> recorder already called', async () => {
    nextAdmin = legacyAdmin({ storage: { [BUCKET]: { data: null, error: { status: 404 } } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(404)
    expect(nextAdmin.rpc).toHaveBeenCalledWith(METRIC_RPC)
  })

  it('J. Storage mismatch downstream -> recorder already called', async () => {
    nextAdmin = legacyAdmin({ storage: { [BUCKET]: { data: { contentType: 'application/pdf', size: 12345 }, error: null } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(nextAdmin.rpc).toHaveBeenCalledWith(METRIC_RPC)
  })

  it('K. Storage ambiguous failure downstream -> recorder already called', async () => {
    nextAdmin = legacyAdmin({ storage: { [BUCKET]: { data: null, error: { status: 500 } } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    expect(nextAdmin.rpc).toHaveBeenCalledWith(METRIC_RPC)
  })

  it('L. metadata insert failure downstream -> recorder already called', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [] }, afterInsert: { data: null, error: { message: 'insert failed' } } } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
    expect(nextAdmin.rpc).toHaveBeenCalledWith(METRIC_RPC)
  })

  it('M. metric recorder failure -> 503, fail closed: no replay lookup, no Storage info, no metadata insert after the boundary', async () => {
    nextMetricRpcResponse = { data: null, error: { message: 'boom' } }
    const res = await POST(req(validBody))
    expect(res.status).toBe(503)
    expect(insertCallCount).toBe(0)
    expect(cleanupUnregisteredUpload).not.toHaveBeenCalled()
    // The replay/conflict lookup (`from(TABLE)` with no insert) and the
    // Storage check must never occur once the metric RPC has failed.
    expect(nextAdmin.from).not.toHaveBeenCalledWith(TABLE)
    const storageCalls = callOrder.filter((c) => c.startsWith('storage.info:'))
    expect(storageCalls).toHaveLength(0)
    const body = await res.json()
    expect(body.error).not.toMatch(/boom|record_kyc_legacy_finalize_attempt|postgres|sql/i)
  })

  it('metric recorder failure -> safe error message never exposed to a different status either', async () => {
    nextMetricRpcResponse = { data: null, error: { message: 'duplicate key value violates unique constraint "some_pg_constraint"' } }
    const res = await POST(req(validBody))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).not.toMatch(/constraint|duplicate key|postgres/i)
  })

  it('N. metric recorder success -> downstream legacy behavior remains unchanged (still 201 on fresh insert)', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(201)
    expect(insertCallCount).toBe(1)
  })

  it('O. B3A intent finalization never calls the legacy metric recorder', async () => {
    const INTENT_ID = '44444444-4444-8444-8444-444444444444'
    nextRpcResponse = { data: registeredRow, error: null }
    const res = await POST(req({ intent_id: INTENT_ID }))
    expect(res.status).toBe(201)
    expect(nextAdmin.rpc).not.toHaveBeenCalled()
    expect(nextSession?.rpc).toHaveBeenCalledWith('finalize_kyc_document_upload', { p_intent_id: INTENT_ID })
  })

  it('P. diagnostic attempt-recorded log occurs only after a successful metric increment', async () => {
    const spy = consoleLogSpy()
    await POST(req(validBody))
    const messages = spy.mock.calls.map((c) => c[0])
    expect(messages).toContain('[verification.documents] kyc_legacy_finalize_attempt_recorded')
    spy.mockRestore()
  })

  it('P2. diagnostic attempt-recorded log does NOT occur when the metric recorder fails', async () => {
    nextMetricRpcResponse = { data: null, error: { message: 'boom' } }
    const spy = consoleLogSpy()
    await POST(req(validBody))
    const messages = spy.mock.calls.map((c) => c[0])
    expect(messages).not.toContain('[verification.documents] kyc_legacy_finalize_attempt_recorded')
    spy.mockRestore()
  })

  it('Q. existing legacy success log semantics remain intact alongside the new diagnostic log', async () => {
    const spy = consoleLogSpy()
    await POST(req(validBody))
    const messages = spy.mock.calls.map((c) => c[0])
    expect(messages).toContain('[verification.documents] kyc_document_finalize_legacy')
    expect(messages).toContain('[verification.documents] kyc_legacy_finalize_attempt_recorded')
    spy.mockRestore()
  })

  it('R. ordering: B2L intent lookup -> metric RPC -> replay lookup -> Storage info -> metadata insert', async () => {
    await POST(req(validBody))
    const relevant = callOrder.filter(
      (c) => c === `from:${INTENTS}` || c === `rpc:${METRIC_RPC}` || c === `from:${TABLE}` || c.startsWith('storage.info:') || c === `insert:${TABLE}`
    )
    // `from:${TABLE}` appears twice on the fresh-insert path -- once for
    // the replay/conflict lookup (immediately after the metric RPC),
    // once immediately preceding the insert call itself.
    expect(relevant).toEqual([
      `from:${INTENTS}`,
      `rpc:${METRIC_RPC}`,
      `from:${TABLE}`,
      `storage.info:${BUCKET}`,
      `from:${TABLE}`,
      `insert:${TABLE}`,
    ])
  })

  it('R2. ordering holds even on a replay (no insert step, but metric still precedes the replay lookup)', async () => {
    nextAdmin = legacyAdmin({ docs: { existing: { data: [registeredRow] } } })
    await POST(req(validBody))
    const relevant = callOrder.filter((c) => c === `from:${INTENTS}` || c === `rpc:${METRIC_RPC}` || c === `from:${TABLE}`)
    expect(relevant).toEqual([`from:${INTENTS}`, `rpc:${METRIC_RPC}`, `from:${TABLE}`])
  })
})
