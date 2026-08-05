import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { requestDisputeEvidenceSchema } from '@/lib/disputes/validation'
import { mapDisputeRpcError } from '@/lib/disputes/rpc-errors'
import { notifyDisputeParties } from '@/lib/disputes/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/disputes/[id]/request-evidence -- open/under_review -> evidence. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!isValidUuid(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:disputes:request-evidence')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = requestDisputeEvidenceSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('request_dispute_evidence', {
    p_admin_id: gate.requester.userId,
    p_dispute_id: disputeId,
    p_note: parsed.data.note ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.disputes.request-evidence] RPC error', { disputeId, error })
    const mapped = mapDisputeRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyDisputeParties(admin, disputeId, 'dispute.evidence_requested', 'dispute-evidence-requested', { note: parsed.data.note ?? '' })
  } catch (emailErr) {
    console.error('[admin.disputes.request-evidence] email dispatch failed', { disputeId, emailErr })
  }

  return NextResponse.json(data)
}
