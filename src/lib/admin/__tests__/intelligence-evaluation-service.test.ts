import { describe, it, expect, vi } from 'vitest'
import {
  isValidEvaluation,
  isValidReasonCode,
  isValidFingerprintFormat,
  getEvaluationsForFingerprints,
  recordIntelligenceEvaluation,
  getRuleQualitySummary,
  EVALUATION_VALUES,
  REASON_CODES,
} from '../intelligence-evaluation-service'

const VALID_FP = 'a'.repeat(64)
const ADMIN_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_ADMIN_ID = '22222222-2222-2222-2222-222222222222'

describe('intelligence-evaluation-service: validation helpers (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('isValidEvaluation accepts exactly the 5 taxonomy values and rejects everything else', () => {
    for (const v of EVALUATION_VALUES) expect(isValidEvaluation(v)).toBe(true)
    expect(isValidEvaluation('useful ')).toBe(false)
    expect(isValidEvaluation('USEFUL')).toBe(false)
    expect(isValidEvaluation(5)).toBe(false)
    expect(isValidEvaluation(null)).toBe(false)
    expect(isValidEvaluation(undefined)).toBe(false)
    expect(isValidEvaluation('great')).toBe(false)
  })

  it('isValidReasonCode accepts exactly the fixed reason-code set and rejects free text', () => {
    for (const v of REASON_CODES) expect(isValidReasonCode(v)).toBe(true)
    expect(isValidReasonCode('this insight was wrong because the user is a scammer')).toBe(false)
    expect(isValidReasonCode('other')).toBe(false) // case-sensitive -- must match the exact enum value
  })

  it('isValidFingerprintFormat requires exactly 64 lowercase hex characters', () => {
    expect(isValidFingerprintFormat(VALID_FP)).toBe(true)
    expect(isValidFingerprintFormat(VALID_FP.toUpperCase())).toBe(false)
    expect(isValidFingerprintFormat(VALID_FP.slice(0, 63))).toBe(false)
    expect(isValidFingerprintFormat(`${VALID_FP}a`)).toBe(false)
    expect(isValidFingerprintFormat('not-a-hash')).toBe(false)
    expect(isValidFingerprintFormat(12345)).toBe(false)
  })
})

function fakeAdmin(opts: { selectData?: unknown; selectError?: unknown; rpcError?: unknown } = {}) {
  const result = { data: opts.selectData ?? [], error: opts.selectError ?? null }
  const inFn = vi.fn().mockResolvedValue(result)
  const eqFn = vi.fn().mockReturnValue({ in: inFn })
  // `.select(...)` must work BOTH as a direct awaitable (getRuleQualitySummary:
  // `await admin.from(...).select(...)`) AND as a chainable builder
  // (getEvaluationsForFingerprints: `.select(...).eq(...).in(...)`) -- a
  // real postgrest-js query builder is both a thenable and chainable.
  const selectFn = vi.fn().mockImplementation(() => Object.assign(Promise.resolve(result), { eq: eqFn }))
  const fromFn = vi.fn().mockReturnValue({ select: selectFn })
  const rpcFn = vi.fn().mockResolvedValue({ data: null, error: opts.rpcError ?? null })
  return { from: fromFn, rpc: rpcFn, selectFn, eqFn, inFn } as const
}

describe('getEvaluationsForFingerprints: batched read (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('an empty fingerprint list short-circuits without querying the database at all', async () => {
    const admin = fakeAdmin()
    const result = await getEvaluationsForFingerprints(admin as never, ADMIN_ID, [])
    expect(result.size).toBe(0)
    expect(admin.from).not.toHaveBeenCalled()
  })

  it('queries exactly once (never once per fingerprint) and returns a correct fingerprint->evaluation map', async () => {
    const admin = fakeAdmin({
      selectData: [
        { insight_fingerprint: VALID_FP, evaluation: 'useful' },
        { insight_fingerprint: 'b'.repeat(64), evaluation: 'needs_investigation' },
      ],
    })
    const result = await getEvaluationsForFingerprints(admin as never, ADMIN_ID, [VALID_FP, 'b'.repeat(64), 'c'.repeat(64)])
    expect(admin.from).toHaveBeenCalledTimes(1)
    expect(admin.from).toHaveBeenCalledWith('admin_intelligence_evaluations')
    expect(admin.eqFn).toHaveBeenCalledWith('admin_user_id', ADMIN_ID)
    expect(admin.inFn).toHaveBeenCalledWith('insight_fingerprint', [VALID_FP, 'b'.repeat(64), 'c'.repeat(64)])
    expect(result.get(VALID_FP)).toBe('useful')
    expect(result.get('b'.repeat(64))).toBe('needs_investigation')
    expect(result.has('c'.repeat(64))).toBe(false)
  })

  it('a read failure fails closed to an empty map, never throws -- Intelligence rendering must survive an evaluation-read error', async () => {
    const admin = fakeAdmin({ selectError: new Error('db down') })
    const result = await getEvaluationsForFingerprints(admin as never, ADMIN_ID, [VALID_FP])
    expect(result.size).toBe(0)
  })

  it('a row with a malformed/unrecognized evaluation value is silently skipped, never surfaced as a fabricated value', async () => {
    const admin = fakeAdmin({ selectData: [{ insight_fingerprint: VALID_FP, evaluation: 'garbage' }] })
    const result = await getEvaluationsForFingerprints(admin as never, ADMIN_ID, [VALID_FP])
    expect(result.size).toBe(0)
  })

  it('is scoped to the given admin id -- never fetches another admin\'s rows regardless of which fingerprints are requested', async () => {
    const admin = fakeAdmin({ selectData: [] })
    await getEvaluationsForFingerprints(admin as never, OTHER_ADMIN_ID, [VALID_FP])
    expect(admin.eqFn).toHaveBeenCalledWith('admin_user_id', OTHER_ADMIN_ID)
    expect(admin.eqFn).not.toHaveBeenCalledWith('admin_user_id', ADMIN_ID)
  })
})

describe('recordIntelligenceEvaluation: persistence (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('calls the record_intelligence_evaluation RPC with exactly the expected parameters', async () => {
    const admin = fakeAdmin()
    const result = await recordIntelligenceEvaluation(admin as never, {
      adminUserId: ADMIN_ID,
      insightFingerprint: VALID_FP,
      fingerprintVersion: 1,
      ruleId: 'GROWTH_NEW_USERS_UP',
      evaluation: 'useful',
      reasonCode: null,
    })
    expect(result.ok).toBe(true)
    expect(admin.rpc).toHaveBeenCalledWith('record_intelligence_evaluation', {
      p_admin_id: ADMIN_ID,
      p_insight_fingerprint: VALID_FP,
      p_fingerprint_version: 1,
      p_rule_id: 'GROWTH_NEW_USERS_UP',
      p_evaluation: 'useful',
      p_reason_code: null,
    })
  })

  it('a reason code is passed through when provided', async () => {
    const admin = fakeAdmin()
    await recordIntelligenceEvaluation(admin as never, {
      adminUserId: ADMIN_ID,
      insightFingerprint: VALID_FP,
      fingerprintVersion: 1,
      ruleId: 'GROWTH_NEW_USERS_UP',
      evaluation: 'incorrect',
      reasonCode: 'STALE_SIGNAL',
    })
    expect(admin.rpc).toHaveBeenCalledWith('record_intelligence_evaluation', expect.objectContaining({ p_reason_code: 'STALE_SIGNAL' }))
  })

  it('an RPC failure returns a contained error result rather than throwing', async () => {
    const admin = fakeAdmin({ rpcError: new Error('constraint violation') })
    const result = await recordIntelligenceEvaluation(admin as never, {
      adminUserId: ADMIN_ID,
      insightFingerprint: VALID_FP,
      fingerprintVersion: 1,
      ruleId: 'GROWTH_NEW_USERS_UP',
      evaluation: 'useful',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })

  it('never inserts directly into either table -- only calls the RPC (the single, atomic, security-definer write path)', async () => {
    const admin = fakeAdmin()
    await recordIntelligenceEvaluation(admin as never, {
      adminUserId: ADMIN_ID,
      insightFingerprint: VALID_FP,
      fingerprintVersion: 1,
      ruleId: 'GROWTH_NEW_USERS_UP',
      evaluation: 'useful',
    })
    expect(admin.from).not.toHaveBeenCalled()
  })
})

describe('getRuleQualitySummary: privacy-safe counts-only aggregate (category: ADMIN-CONTROL-CENTRE-BATCH-E3)', () => {
  it('aggregates counts by rule id without ever computing or exposing a percentage/conclusion', async () => {
    const admin = fakeAdmin({
      selectData: [
        { rule_id: 'GROWTH_NEW_USERS_UP', evaluation: 'useful' },
        { rule_id: 'GROWTH_NEW_USERS_UP', evaluation: 'useful' },
        { rule_id: 'GROWTH_NEW_USERS_UP', evaluation: 'incorrect' },
        { rule_id: 'OPERATIONS_SUPPORT_BACKLOG', evaluation: 'needs_investigation' },
      ],
    })
    const summary = await getRuleQualitySummary(admin as never)
    const growth = summary.find((r) => r.ruleId === 'GROWTH_NEW_USERS_UP')
    expect(growth).toEqual({ ruleId: 'GROWTH_NEW_USERS_UP', total: 3, useful: 2, notUseful: 0, incorrect: 1, needsMoreData: 0, needsInvestigation: 0 })
    const ops = summary.find((r) => r.ruleId === 'OPERATIONS_SUPPORT_BACKLOG')
    expect(ops).toEqual({ ruleId: 'OPERATIONS_SUPPORT_BACKLOG', total: 1, useful: 0, notUseful: 0, incorrect: 0, needsMoreData: 0, needsInvestigation: 1 })
    // Only counts -- no percentage field exists on the row shape at all.
    expect(Object.keys(growth ?? {})).not.toContain('percentage')
  })

  it('a read failure returns an empty list rather than throwing', async () => {
    const admin = fakeAdmin({ selectError: new Error('db down') })
    const summary = await getRuleQualitySummary(admin as never)
    expect(summary).toEqual([])
  })
})
