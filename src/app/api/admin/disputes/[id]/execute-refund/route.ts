import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { completeDisputeFinancialDispositionSchema } from '@/lib/disputes/validation'
import { completeDisputeRefundWithProvider, OrchestrationError, isRetryableOrchestrationError } from '@/lib/payments/orchestrator'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/disputes/[id]/execute-refund -- E29. The provider-
 * grounded replacement for admin attestation on a refund_required
 * disposition: calls the payment provider's own refund() (synchronous
 * result -- see src/lib/payments/provider.ts) via
 * completeDisputeRefundWithProvider(), which brackets that call with
 * start_refund_provider_attempt() / record_refund_provider_result()
 * (migration 20261111112418). On a 'completed' provider result, the
 * linked financial disposition is completed automatically in the same
 * DB call that records it -- this route never calls
 * complete_dispute_financial_disposition() itself. On 'failed', the
 * disposition remains pending and payout remains blocked, exactly as
 * required.
 *
 * Reuses completeDisputeFinancialDispositionSchema purely for its shape
 * (an optional idempotency_key) -- this route takes no other input; the
 * refund amount/payment/reason were already fixed when the disposition
 * was created.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!isValidUuid(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:disputes:execute-refund')
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

  const { data: disposition, error: dispositionFetchError } = await admin
    .from('dispute_financial_dispositions')
    .select('id, disposition_type, status, refund_id')
    .eq('dispute_id', disputeId)
    .maybeSingle()
  if (dispositionFetchError) {
    console.error('[admin.disputes.execute-refund] disposition fetch error', { disputeId, dispositionFetchError })
    return NextResponse.json({ error: 'Could not process your request — please try again' }, { status: 500 })
  }
  if (!disposition) {
    return NextResponse.json({ error: 'No financial disposition exists for this dispute.' }, { status: 404 })
  }
  if (disposition.disposition_type !== 'refund_required' || !disposition.refund_id) {
    return NextResponse.json({ error: 'This dispute does not have a refund to execute.' }, { status: 400 })
  }
  if (disposition.status !== 'pending') {
    return NextResponse.json({ error: 'This financial disposition is not pending completion.' }, { status: 409 })
  }

  try {
    const result = await completeDisputeRefundWithProvider(
      { admin, providerName: process.env.PAYMENT_PROVIDER },
      disposition.refund_id,
      gate.requester.userId,
      parsed.data.idempotency_key
    )
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof OrchestrationError) {
      console.error('[admin.disputes.execute-refund] orchestration error', { disputeId, code: err.code, message: err.message })
      if (isRetryableOrchestrationError(err.code)) {
        return NextResponse.json({ error: 'A temporary issue stopped this refund. Please try again.' }, { status: 503 })
      }
      if (err.code === 'provider_configuration_error') {
        return NextResponse.json({ error: 'The payment provider does not support refund execution yet.' }, { status: 503 })
      }
      if (err.code === 'duplicate_workflow_conflict') {
        return NextResponse.json({ error: err.message }, { status: 409 })
      }
      if (err.code === 'missing_payment') {
        return NextResponse.json({ error: err.message }, { status: 404 })
      }
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error('[admin.disputes.execute-refund] unexpected error', { disputeId, err })
    return NextResponse.json({ error: 'Could not process your request — please try again' }, { status: 500 })
  }
}
