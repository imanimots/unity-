import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
}))

const getIntelligenceInsights = vi.fn()
vi.mock('@/lib/admin/intelligence-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin/intelligence-service')>('@/lib/admin/intelligence-service')
  return { ...actual, getIntelligenceInsights: (...args: unknown[]) => getIntelligenceInsights(...args) }
})

const recordIntelligenceEvaluation = vi.fn()
vi.mock('@/lib/admin/intelligence-evaluation-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin/intelligence-evaluation-service')>('@/lib/admin/intelligence-evaluation-service')
  return { ...actual, recordIntelligenceEvaluation: (...args: unknown[]) => recordIntelligenceEvaluation(...args) }
})

const { POST } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const VALID_FP = 'a'.repeat(64)
const LIVE_INSIGHT = { fingerprint: VALID_FP, ruleId: 'GROWTH_NEW_USERS_UP', fingerprintVersion: 1 }

function call(body: unknown) {
  return POST(new NextRequest('http://localhost/api/admin/intelligence/evaluations', { method: 'POST', body: JSON.stringify(body) }))
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { fingerprint: VALID_FP, fingerprintVersion: 1, ruleId: 'GROWTH_NEW_USERS_UP', evaluation: 'useful', ...overrides }
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue({})
  getIntelligenceInsights.mockReset().mockResolvedValue({ insights: [LIVE_INSIGHT] })
  recordIntelligenceEvaluation.mockReset().mockResolvedValue({ ok: true })
})

describe('POST /api/admin/intelligence/evaluations: authorization (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('1. an unauthenticated/non-admin caller is rejected before anything is persisted', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call(validBody())
    expect(res.status).toBe(401)
    expect(recordIntelligenceEvaluation).not.toHaveBeenCalled()
    expect(getIntelligenceInsights).not.toHaveBeenCalled()
  })

  it('2. an authorized admin is accepted and the evaluation is persisted', async () => {
    const res = await call(validBody())
    expect(res.status).toBe(200)
    expect(recordIntelligenceEvaluation).toHaveBeenCalled()
  })

  it('3. the admin identity used for attribution comes ONLY from the server-side session, never from the request body -- a client-supplied adminUserId field is ignored entirely', async () => {
    await call(validBody({ adminUserId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', admin_user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }))
    expect(recordIntelligenceEvaluation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ adminUserId: ADMIN_ID }))
  })

  it('4. a malformed fingerprint (wrong length/characters) is rejected with 400 before any DB call', async () => {
    const res = await call(validBody({ fingerprint: 'not-a-real-fingerprint' }))
    expect(res.status).toBe(400)
    expect(getIntelligenceInsights).not.toHaveBeenCalled()
    expect(recordIntelligenceEvaluation).not.toHaveBeenCalled()
  })

  it('5. an unknown ruleId (not one of RULE_IDS) is rejected with 400', async () => {
    const res = await call(validBody({ ruleId: 'SOMETHING_MADE_UP' }))
    expect(res.status).toBe(400)
    expect(recordIntelligenceEvaluation).not.toHaveBeenCalled()
  })

  it('6. an invalid evaluation value (outside the 5-value taxonomy) is rejected with 400', async () => {
    const res = await call(validBody({ evaluation: 'amazing' }))
    expect(res.status).toBe(400)
    expect(recordIntelligenceEvaluation).not.toHaveBeenCalled()
  })

  it('7. an invalid reasonCode (free text, not one of the fixed codes) is rejected with 400', async () => {
    const res = await call(validBody({ reasonCode: 'the user seemed suspicious to me' }))
    expect(res.status).toBe(400)
    expect(recordIntelligenceEvaluation).not.toHaveBeenCalled()
  })

  it('8. a non-integer or non-positive fingerprintVersion is rejected with 400', async () => {
    const res = await call(validBody({ fingerprintVersion: 0 }))
    expect(res.status).toBe(400)
    expect(recordIntelligenceEvaluation).not.toHaveBeenCalled()
  })

  it('9. malformed JSON body is rejected with 400, not a 500 crash', async () => {
    const res = await POST(new NextRequest('http://localhost/api/admin/intelligence/evaluations', { method: 'POST', body: '{not json' }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/admin/intelligence/evaluations: tamper resistance (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('1. regenerates Intelligence server-side and rejects a fingerprint/ruleId pair that does not match any currently-generated insight', async () => {
    getIntelligenceInsights.mockResolvedValue({ insights: [] }) // nothing currently matches
    const res = await call(validBody())
    expect(res.status).toBe(409)
    expect(recordIntelligenceEvaluation).not.toHaveBeenCalled()
  })

  it('2. rejects a fingerprint that matches a live insight but under the WRONG ruleId -- both must match the same insight', async () => {
    getIntelligenceInsights.mockResolvedValue({ insights: [{ fingerprint: VALID_FP, ruleId: 'OPERATIONS_SUPPORT_BACKLOG', fingerprintVersion: 1 }] })
    const res = await call(validBody({ ruleId: 'GROWTH_NEW_USERS_UP' }))
    expect(res.status).toBe(409)
    expect(recordIntelligenceEvaluation).not.toHaveBeenCalled()
  })

  it('3. accepts and persists when the fingerprint/ruleId pair matches a currently-generated insight exactly', async () => {
    const res = await call(validBody())
    expect(res.status).toBe(200)
    expect(recordIntelligenceEvaluation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ insightFingerprint: VALID_FP, ruleId: 'GROWTH_NEW_USERS_UP' })
    )
  })

  it('4. an Intelligence-regeneration failure during validation returns a contained 503, not a crash, and persists nothing', async () => {
    getIntelligenceInsights.mockRejectedValue(new Error('all sources down'))
    const res = await call(validBody())
    expect(res.status).toBe(503)
    expect(recordIntelligenceEvaluation).not.toHaveBeenCalled()
    const json = await res.json()
    expect(JSON.stringify(json)).not.toMatch(/all sources down/)
  })
})

describe('POST /api/admin/intelligence/evaluations: failure containment (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('1. storage not configured returns 503, not a crash', async () => {
    getAdminServiceClient.mockResolvedValue(null)
    const res = await call(validBody())
    expect(res.status).toBe(503)
  })

  it('2. a persistence failure returns a contained error, never a raw database error string', async () => {
    recordIntelligenceEvaluation.mockResolvedValue({ ok: false, error: 'Could not save this evaluation. Please try again.' })
    const res = await call(validBody())
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json.error).not.toMatch(/constraint|relation|syntax error|postgres/i)
  })
})
