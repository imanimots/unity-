import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'
process.env.INTERNAL_CRON_SECRET = 'test-internal-cron-secret'

const SECRET = 'test-internal-cron-secret'
const USER = '22222222-2222-2222-2222-222222222222'
const OTHER_USER = '99999999-9999-9999-9999-999999999999'
const LEAF = '33333333-3333-3333-3333-333333333333'
const PATH = `${USER}/identity_document/${LEAF}.jpg`

const INTENTS = 'kyc_document_upload_intents'
const METADATA = 'identity_verification_documents'

// ── Fake service-role client. Configured per test via `cfg`. ──
interface Cfg {
  claim?: { data: unknown; error?: unknown }
  metadataRows?: unknown[] // rows returned by .from('identity_verification_documents').select('id').eq('storage_path', X)
  metadataError?: unknown
  storageInfo?: { data: unknown; error?: unknown } // .storage.from(BUCKET).info(X)
  storageRemoveError?: unknown // .storage.from(BUCKET).remove([X])
}
let cfg: Cfg
const updateCalls: { table: string; payload: Record<string, unknown>; eqs: [string, unknown][] }[] = []
const removeCalls: string[][] = []

function fakeAdmin() {
  const rpc = vi.fn(() => Promise.resolve(cfg.claim ?? { data: { candidates: [] }, error: null }))

  const from = vi.fn((table: string) => {
    const eqs: [string, unknown][] = []
    let pendingUpdate: Record<string, unknown> | null = null
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (payload: Record<string, unknown>) => {
        pendingUpdate = payload
        return chain
      },
      eq: (col: string, val: unknown) => {
        eqs.push([col, val])
        if (pendingUpdate && eqs.length >= 2) {
          updateCalls.push({ table, payload: pendingUpdate, eqs: [...eqs] })
        }
        return chain
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        if (table === METADATA) {
          return Promise.resolve({ data: cfg.metadataError ? null : (cfg.metadataRows ?? []), error: cfg.metadataError ?? null }).then(resolve, reject)
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject)
      },
    }
    return chain
  })

  const storage = {
    from: () => ({
      info: vi.fn(() => Promise.resolve(cfg.storageInfo ?? { data: { contentType: 'image/jpeg', size: 1 }, error: null })),
      remove: vi.fn((paths: string[]) => {
        removeCalls.push(paths)
        return Promise.resolve({ data: null, error: cfg.storageRemoveError ?? null })
      }),
    }),
  }
  return { rpc, from, storage }
}

let nextAdmin: ReturnType<typeof fakeAdmin>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { POST } = await import('../route')

function req(auth?: string) {
  return new NextRequest('http://localhost/api/internal/kyc/cleanup-upload-intents', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  })
}

function candidate(over: Partial<{ id: string; user_id: string; document_type: string; storage_path: string; is_retry: boolean }> = {}) {
  return { id: 'intent-1', user_id: USER, document_type: 'identity_document', storage_path: PATH, is_retry: false, ...over }
}

beforeEach(() => {
  cfg = {}
  updateCalls.length = 0
  removeCalls.length = 0
  nextAdmin = fakeAdmin()
  process.env.INTERNAL_CRON_SECRET = SECRET
})

describe('POST /api/internal/kyc/cleanup-upload-intents -- auth (category: KYC B3C)', () => {
  it('A. INTERNAL_CRON_SECRET unset -> 503', async () => {
    delete process.env.INTERNAL_CRON_SECRET
    const res = await POST(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(503)
  })

  it('B. missing authorization -> 401', async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
  })

  it('C. wrong secret -> 401', async () => {
    const res = await POST(req('Bearer nope'))
    expect(res.status).toBe(401)
  })

  it('D. correct secret -> executes (calls the claim RPC)', async () => {
    const res = await POST(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(nextAdmin.rpc).toHaveBeenCalledWith('claim_expired_kyc_upload_intents', { p_limit: 100 })
  })

  it('E. no caller-controlled target inputs -- body is ignored entirely', async () => {
    const r = new NextRequest('http://localhost/api/internal/kyc/cleanup-upload-intents', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_limit: 999999, intent_id: 'x', storage_path: 'y', user_id: 'z' }),
    })
    const res = await POST(r)
    expect(res.status).toBe(200)
    expect(nextAdmin.rpc).toHaveBeenCalledWith('claim_expired_kyc_upload_intents', { p_limit: 100 })
  })

  it('F. response is aggregate-only -- no ids/paths/users', async () => {
    cfg.claim = { data: { candidates: [candidate({ storage_path: PATH })] }, error: null }
    cfg.storageInfo = { data: null, error: { status: 404 } }
    const res = await POST(req(`Bearer ${SECRET}`))
    const body = await res.json()
    const text = JSON.stringify(body)
    expect(text).not.toContain(USER)
    expect(text).not.toContain(PATH)
    expect(text).not.toContain('intent-1')
    expect(Object.keys(body).sort()).toEqual(
      ['claimed_first_time', 'claimed_retry', 'cleaned', 'duration_ms', 'invalid_paths', 'metadata_errors', 'preserved', 'scanned', 'storage_errors'].sort()
    )
  })

  it('G. one candidate failure does not abort the rest', async () => {
    cfg.claim = {
      data: {
        candidates: [
          candidate({ id: 'bad', storage_path: `${OTHER_USER}/identity_document/${LEAF}.jpg` }), // invalid_path (cross-user)
          candidate({ id: 'good', storage_path: PATH }),
        ],
      },
      error: null,
    }
    cfg.storageInfo = { data: null, error: { status: 404 } } // 'good' -> cleaned
    const res = await POST(req(`Bearer ${SECRET}`))
    const body = await res.json()
    expect(body.scanned).toBe(2)
    expect(body.invalid_paths).toBe(1)
    expect(body.cleaned).toBe(1)
  })

  it('H. no provider/status system mutation -- route only ever calls the claim RPC + cleanup helper', async () => {
    cfg.claim = { data: { candidates: [] }, error: null }
    await POST(req(`Bearer ${SECRET}`))
    expect(nextAdmin.rpc).toHaveBeenCalledTimes(1)
    expect(nextAdmin.rpc).toHaveBeenCalledWith('claim_expired_kyc_upload_intents', { p_limit: 100 })
  })

  it('claim RPC error -> 500, sanitized', async () => {
    cfg.claim = { data: null, error: { code: '42501', message: 'permission denied for function claim_expired_kyc_upload_intents' } }
    const res = await POST(req(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toMatch(/permission denied|function/i)
  })
})

describe('cleanup lifecycle via the route (category: KYC B3C)', () => {
  async function run(cs: ReturnType<typeof candidate>[]) {
    cfg.claim = { data: { candidates: cs }, error: null }
    const res = await POST(req(`Bearer ${SECRET}`))
    return res.json()
  }

  it('J. expired + no object -> cleaned, no delete', async () => {
    cfg.storageInfo = { data: null, error: { status: 404 } }
    const body = await run([candidate()])
    expect(body.cleaned).toBe(1)
    expect(removeCalls).toHaveLength(0)
    expect(updateCalls).toContainEqual(expect.objectContaining({ table: INTENTS, payload: expect.objectContaining({ status: 'cleaned' }) }))
  })

  it('K. expired + object present -> delete + cleaned', async () => {
    cfg.storageInfo = { data: { contentType: 'image/jpeg', size: 1 }, error: null }
    const body = await run([candidate()])
    expect(body.cleaned).toBe(1)
    expect(removeCalls).toContainEqual([PATH])
    expect(updateCalls).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ status: 'cleaned' }) }))
  })

  it('L. registered metadata at exact path -> preserved, NO delete, NO cleaned', async () => {
    cfg.metadataRows = [{ id: 'doc-1' }]
    const body = await run([candidate()])
    expect(body.preserved).toBe(1)
    expect(body.cleaned).toBe(0)
    expect(removeCalls).toHaveLength(0)
    expect(updateCalls).toContainEqual(expect.objectContaining({ payload: { status: 'preserved' } }))
  })

  it('L2. registered metadata with CONFLICTING details -> still preserved, still no delete (equality not required)', async () => {
    cfg.metadataRows = [{ id: 'doc-1' }, { id: 'doc-2' }]
    const body = await run([candidate()])
    expect(body.preserved).toBe(1)
    expect(removeCalls).toHaveLength(0)
  })

  it('M. metadata query error -> metadata_errors, no Storage op, no state change', async () => {
    cfg.metadataError = { message: 'connection reset' }
    const body = await run([candidate()])
    expect(body.metadata_errors).toBe(1)
    expect(removeCalls).toHaveLength(0)
    expect(updateCalls).toHaveLength(0)
  })

  it('N. invalid stored path (cross-user) -> invalid_paths, no Storage op, no state change', async () => {
    const body = await run([candidate({ storage_path: `${OTHER_USER}/identity_document/${LEAF}.jpg` })])
    expect(body.invalid_paths).toBe(1)
    expect(removeCalls).toHaveLength(0)
    expect(updateCalls).toHaveLength(0)
  })

  it('N2. invalid stored path (malformed) -> invalid_paths', async () => {
    const body = await run([candidate({ storage_path: `${USER}/identity_document/not-a-uuid.jpg` })])
    expect(body.invalid_paths).toBe(1)
    expect(removeCalls).toHaveLength(0)
  })

  it('O. ambiguous Storage info error -> storage_errors, no delete, no cleaned', async () => {
    cfg.storageInfo = { data: null, error: { status: 500, message: 'upstream unavailable' } }
    const body = await run([candidate()])
    expect(body.storage_errors).toBe(1)
    expect(removeCalls).toHaveLength(0)
    expect(updateCalls).toHaveLength(0)
  })

  it('P. Storage delete failure -> storage_errors, no cleaned (stays expired, retryable)', async () => {
    cfg.storageInfo = { data: { contentType: 'image/jpeg', size: 1 }, error: null }
    cfg.storageRemoveError = { message: 'transient' }
    const body = await run([candidate()])
    expect(body.storage_errors).toBe(1)
    expect(body.cleaned).toBe(0)
    expect(removeCalls).toContainEqual([PATH])
    expect(updateCalls).toHaveLength(0) // never marked cleaned
  })

  it('Q. delete-response-loss recovery: a later run sees the object absent -> cleaned', async () => {
    // First run: delete "fails" (response lost) -> storage_error, stays expired.
    cfg.storageInfo = { data: { contentType: 'image/jpeg', size: 1 }, error: null }
    cfg.storageRemoveError = { message: 'ECONNRESET' }
    let body = await run([candidate({ is_retry: true })])
    expect(body.storage_errors).toBe(1)
    // Second run (retry candidate): object now absent -> cleaned.
    updateCalls.length = 0
    removeCalls.length = 0
    cfg.storageRemoveError = undefined
    cfg.storageInfo = { data: null, error: { status: 404 } }
    body = await run([candidate({ is_retry: true })])
    expect(body.cleaned).toBe(1)
    expect(removeCalls).toHaveLength(0)
  })

  it('R. already-absent object -> cleaned (same as J)', async () => {
    cfg.storageInfo = { data: null, error: { status: 400 } }
    const body = await run([candidate()])
    expect(body.cleaned).toBe(1)
  })

  it('T3. first-time vs retry counters reflect the claim function\'s is_retry flag', async () => {
    cfg.storageInfo = { data: null, error: { status: 404 } }
    const body = await run([candidate({ id: 'a', is_retry: false }), candidate({ id: 'b', storage_path: `${USER}/proof_of_address/${LEAF}.pdf`, document_type: 'proof_of_address', is_retry: true })])
    expect(body.claimed_first_time).toBe(1)
    expect(body.claimed_retry).toBe(1)
    expect(body.scanned).toBe(2)
  })

  it('every terminal update is conditional on status = expired (no regression of a concurrently-terminated row)', async () => {
    cfg.storageInfo = { data: null, error: { status: 404 } }
    await run([candidate()])
    const cleanedUpdate = updateCalls.find((u) => (u.payload as { status?: string }).status === 'cleaned')
    expect(cleanedUpdate?.eqs).toContainEqual(['status', 'expired'])
  })
})
