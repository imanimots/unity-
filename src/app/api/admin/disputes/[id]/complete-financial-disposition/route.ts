import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { completeDisputeFinancialDispositionSchema } from '@/lib/disputes/validation'
import { mapDisputeRpcError } from '@/lib/disputes/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/disputes/[id]/complete-financial-disposition --
 * records the admin's explicit attestation that a pending
 * refund_required/manual_financial_settlement disposition's money has
 * actually moved (verified by the admin outside this system -- see
 * supabase/migrations/20261108180657's own header for why no
 * automated completion signal exists). Never calls a payment
 * provider, never re-executes create_refund, never touches payments/
 * refunds/escrow_transactions -- detection and attestation only.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!isValidUuid(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:disputes:complete-financial-disposition')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = completeDisputeFinancialDispositionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('complete_dispute_financial_disposition', {
    p_admin_id: gate.requester.userId,
    p_dispute_id: disputeId,
    p_completion_notes: parsed.data.completion_notes ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.disputes.complete-financial-disposition] RPC error', { disputeId, error })
    const mapped = mapDisputeRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
