import type { OrchestratorContext } from './types'
import { authorizeBookingFinancials } from './authorize-booking-financials'
import { checkAndRecordLateSuccessIfExpired } from '@/lib/bookings/late-payment-reconciliation'

/**
 * Narrow resume/reconcile entry point for the webhook route -- the route
 * itself must never contain business orchestration (see
 * src/app/api/payments/webhooks/[provider]/route.ts's own module
 * comment). This is deliberately minimal: it only knows how to resume a
 * financial_workflows row stuck at 'failed_retryable'. There is no real
 * provider event shape to map from yet (Peach mappings are out of scope
 * this pass) -- NormalizedPaymentEvent is intentionally small enough that
 * a synthetic test event and a future real Peach-derived event can both
 * satisfy it without this function changing.
 */
export interface NormalizedPaymentEvent {
  eventId: string
  type: string
  bookingId?: string
}

export interface ReconcileResult {
  reconciled: boolean
  reason: string
}

export async function reconcileProviderEvent(ctx: OrchestratorContext, event: NormalizedPaymentEvent): Promise<ReconcileResult> {
  if (!event.bookingId) {
    return { reconciled: false, reason: 'event carries no booking reference to reconcile against' }
  }

  const { data: workflow } = await ctx.admin
    .from('financial_workflows')
    .select('id, status')
    .eq('booking_id', event.bookingId)
    .eq('workflow_type', 'authorize_booking_financials')
    .maybeSingle()

  if (!workflow) {
    return { reconciled: false, reason: 'no financial workflow exists for this booking' }
  }
  if (workflow.status === 'completed') {
    return { reconciled: false, reason: 'workflow already completed -- not re-executed' }
  }
  if (workflow.status !== 'failed_retryable') {
    return { reconciled: false, reason: `workflow status "${workflow.status}" is not resumable via reconciliation` }
  }

  try {
    await authorizeBookingFinancials(ctx, event.bookingId)

    // Same race guard as the checkout route (Step 6): the payment
    // deadline may have passed while this resume was in flight -- see
    // docs/PAYMENT_READINESS.md "Late provider events".
    const { lateSuccess } = await checkAndRecordLateSuccessIfExpired(ctx.admin, event.bookingId)
    if (lateSuccess) {
      return { reconciled: true, reason: 'resumed and completed, but the booking had already expired unpaid -- flagged for manual review' }
    }

    return { reconciled: true, reason: 'resumed and completed' }
  } catch {
    // Resume attempt failed again -- already durably recorded on
    // financial_workflows by authorizeBookingFinancials itself. The
    // webhook route must still return 200 to the provider regardless
    // (replay safety), so this is swallowed here, not re-thrown.
    return { reconciled: false, reason: 'resume attempt failed -- see financial_workflows.last_error_code' }
  }
}
