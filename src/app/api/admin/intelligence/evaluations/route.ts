import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getIntelligenceInsights, RULE_IDS, type RuleId } from '@/lib/admin/intelligence-service'
import {
  isValidFingerprintFormat,
  isValidEvaluation,
  isValidReasonCode,
  recordIntelligenceEvaluation,
} from '@/lib/admin/intelligence-evaluation-service'

const KNOWN_RULE_IDS = new Set<string>(Object.values(RULE_IDS))

const evaluationRequestSchema = z.object({
  fingerprint: z.string().refine(isValidFingerprintFormat, { message: 'fingerprint must be a 64-character hex SHA-256 digest' }),
  fingerprintVersion: z.number().int().positive(),
  ruleId: z.string().refine((v) => KNOWN_RULE_IDS.has(v), { message: 'Unknown ruleId' }),
  evaluation: z.string().refine(isValidEvaluation, { message: 'Invalid evaluation value' }),
  reasonCode: z
    .string()
    .nullable()
    .optional()
    .refine((v) => v === null || v === undefined || isValidReasonCode(v), { message: 'Invalid reasonCode' }),
})

/**
 * POST /api/admin/intelligence/evaluations -- E3's only write surface
 * for the Human Evaluation Ledger. Records the calling admin's current
 * rating of one Intelligence insight OCCURRENCE (identified by its
 * `fingerprint`, never by raw evidence).
 *
 * Tamper resistance (E3 Section 13): the client's claimed
 * (fingerprint, ruleId) pair is never trusted at face value. Intelligence
 * is regenerated server-side on every submission and the pair must
 * match a CURRENTLY-generated insight before anything is persisted --
 * this is the one extra getIntelligenceInsights() call the E3 brief
 * explicitly accepts as the cost of this guarantee. A client cannot
 * write a rating for a ruleId/fingerprint combination that doesn't
 * actually exist right now. The admin identity used for attribution
 * comes ONLY from requireAdminForRoute()'s own server-side session
 * check -- never from the request body.
 *
 * This route never changes insight generation, priority, confidence,
 * data sufficiency, or ranking -- it only ever calls
 * recordIntelligenceEvaluation(), which writes to the evaluation ledger
 * tables, never back into the Intelligence pipeline.
 */
export async function POST(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:intelligence:evaluations')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = evaluationRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Intelligence evaluation storage is not configured' }, { status: 503 })
  }

  // Tamper-resistance: confirm this (ruleId, fingerprint) pair matches a
  // currently-generated insight before persisting anything. This also
  // means a single failing Intelligence source (E1-F1) cannot be
  // bypassed or weakened here -- getIntelligenceInsights() already
  // isolates its own source failures and always returns a valid result.
  let liveResult: Awaited<ReturnType<typeof getIntelligenceInsights>>
  try {
    liveResult = await getIntelligenceInsights(admin)
  } catch {
    return NextResponse.json({ error: 'Could not verify this insight right now. Please try again.' }, { status: 503 })
  }

  const matchingInsight = liveResult.insights.find(
    (i) => i.fingerprint === parsed.data.fingerprint && i.ruleId === (parsed.data.ruleId as RuleId)
  )
  if (!matchingInsight) {
    return NextResponse.json({ error: 'This insight no longer matches a currently-generated finding and cannot be rated.' }, { status: 409 })
  }

  const result = await recordIntelligenceEvaluation(admin, {
    adminUserId: gate.requester.userId,
    insightFingerprint: parsed.data.fingerprint,
    fingerprintVersion: parsed.data.fingerprintVersion,
    ruleId: parsed.data.ruleId,
    evaluation: parsed.data.evaluation,
    reasonCode: parsed.data.reasonCode ?? null,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
