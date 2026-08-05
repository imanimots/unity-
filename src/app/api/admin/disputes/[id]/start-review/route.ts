import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { disputeActionSchema } from '@/lib/disputes/validation'
import { mapDisputeRpcError } from '@/lib/disputes/rpc-errors'
import { notifyDisputeParties } from '@/lib/disputes/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/disputes/[id]/start-review -- open/evidence -> under_review. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!isValidUuid(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:disputes:start-review')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = disputeActionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('start_dispute_review', {
    p_admin_id: gate.requester.userId,
    p_dispute_id: disputeId,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.disputes.start-review] RPC error', { disputeId, error })
    const mapped = mapDisputeRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    await notifyDisputeParties(admin, disputeId, 'dispute.under_review', 'dispute-under-review')
  } catch (emailErr) {
    console.error('[admin.disputes.start-review] email dispatch failed', { disputeId, emailErr })
  }

  return NextResponse.json(data)
}
