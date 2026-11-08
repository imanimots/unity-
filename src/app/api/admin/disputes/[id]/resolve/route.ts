import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { resolveDisputeSchema, validateBookingFinancialDisposition } from '@/lib/disputes/validation'
import { mapDisputeRpcError } from '@/lib/disputes/rpc-errors'
import { notifyDisputeParties } from '@/lib/disputes/notify'
import { getDisputeOutcomeLabel } from '@/lib/disputes/status-labels'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/disputes/[id]/resolve -- under_review -> resolved,
 * records the outcome. No financial EXECUTION happens here -- see
 * docs/DISPUTE_SYSTEM.md.
 *
 * E28: for a BOOKING dispute specifically, a financial disposition is
 * now a required part of resolving it -- it must be impossible for a
 * financially ambiguous booking outcome to silently mean "normal
 * payout flow resumes" (see supabase/migrations/20261108180657). This
 * is enforced here, not inside the shared resolve_dispute() RPC
 * itself, so order/order/barter/RTB dispute resolution is completely
 * unaffected -- their booking_id is null, so this requirement never
 * applies to them. The dispute's domain is checked BEFORE calling any
 * RPC, so a missing/invalid disposition on a booking dispute fails
 * with a clean 400 and mutates nothing.
 */
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

  const { data: disputeRow, error: disputeFetchError } = await admin.from('disputes').select('booking_id').eq('id', disputeId).maybeSingle()
  if (disputeFetchError) {
    console.error('[admin.disputes.resolve] dispute fetch error', { disputeId, disputeFetchError })
    return NextResponse.json({ error: 'Could not process your request — please try again' }, { status: 500 })
  }
  if (!disputeRow) {
    return NextResponse.json({ error: 'Dispute not found.' }, { status: 404 })
  }

  const isBookingDispute = disputeRow.booking_id !== null
  const dispositionValidationError = validateBookingFinancialDisposition(isBookingDispute, parsed.data)
  if (dispositionValidationError) {
    return NextResponse.json({ error: dispositionValidationError }, { status: 400 })
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

  let disposition: unknown = null
  if (isBookingDispute) {
    const { data: dispositionData, error: dispositionError } = await admin.rpc('record_dispute_financial_disposition', {
      p_admin_id: gate.requester.userId,
      p_dispute_id: disputeId,
      p_disposition_type: parsed.data.financial_disposition_type,
      p_amount: parsed.data.financial_disposition_amount ?? null,
      p_reason: parsed.data.financial_disposition_reason,
      p_idempotency_key: parsed.data.idempotency_key ? `${parsed.data.idempotency_key}-disposition` : null,
    })
    if (dispositionError) {
      console.error('[admin.disputes.resolve] financial disposition RPC error', { disputeId, dispositionError })
      const mapped = mapDisputeRpcError(dispositionError.message)
      // The dispute itself is already resolved at this point (resolve_dispute
      // succeeded above and is idempotent) -- retrying this exact request
      // with the same idempotency_key will safely no-op the resolve step
      // and retry only the disposition step.
      return NextResponse.json({ error: `Dispute resolved, but the financial disposition failed: ${mapped.error} Retry this request to record it.` }, { status: mapped.status })
    }
    disposition = dispositionData
  }

  try {
    await notifyDisputeParties(admin, disputeId, 'dispute.resolved', 'dispute-resolved', {
      outcomeLabel: getDisputeOutcomeLabel(parsed.data.outcome),
    })
  } catch (emailErr) {
    console.error('[admin.disputes.resolve] email dispatch failed', { disputeId, emailErr })
  }

  return NextResponse.json({ ...(data as Record<string, unknown>), financial_disposition: disposition })
}
