import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { assignDisputeSchema } from '@/lib/disputes/validation'
import { mapDisputeRpcError } from '@/lib/disputes/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/disputes/[id]/assign -- assigns a dispute to an admin for handling. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!isValidUuid(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:disputes:assign')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = assignDisputeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('assign_dispute_to_admin', {
    p_admin_id: gate.requester.userId,
    p_dispute_id: disputeId,
    p_assignee_admin_id: parsed.data.assignee_admin_id,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.disputes.assign] RPC error', { disputeId, error })
    const mapped = mapDisputeRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
