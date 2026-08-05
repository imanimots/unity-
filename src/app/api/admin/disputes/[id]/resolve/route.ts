import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { resolveDisputeSchema } from '@/lib/disputes/validation'
import { mapDisputeRpcError } from '@/lib/disputes/rpc-errors'
import { notifyDisputeParties } from '@/lib/disputes/notify'
import { getDisputeOutcomeLabel } from '@/lib/disputes/status-labels'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/disputes/[id]/resolve -- under_review -> resolved, records the outcome. No financial execution -- see docs/DISPUTE_SYSTEM.md. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!isValidUuid(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:disputes:resolve')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = resolveDisputeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('resolve_dispute', {
    p_admin_id: gate.requester.userId,
    p_dispute_id: disputeId,
    p_outcome: parsed.data.outcome,
    p_resolution_notes: parsed.data.resolution_notes ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.disputes.resolve] RPC error', { disputeId, error })
    const mapped = mapDisputeRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyDisputeParties(admin, disputeId, 'dispute.resolved', 'dispute-resolved', {
      outcomeLabel: getDisputeOutcomeLabel(parsed.data.outcome),
    })
  } catch (emailErr) {
    console.error('[admin.disputes.resolve] email dispatch failed', { disputeId, emailErr })
  }

  return NextResponse.json(data)
}
