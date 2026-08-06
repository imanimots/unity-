import type { OrchestratorContext } from './types'
import { OrchestrationError, type OrchestrationErrorCode } from './errors'
import { prepareOrderFinancials } from './prepare-order-financials'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'
import { getPaymentProvider } from '../registry'
import { qualifySaleAffiliateCommission } from '@/lib/affiliate/qualify'

export interface ChargeOrderPaymentResult {
  paymentId: string
  status: 'captured'
  orderStatus: 'paid'
}

/**
 * Single-step charge for a purchase order -- unlike
 * authorizeBookingFinancials() (genuinely multi-step: rental charge THEN
 * deposit authorization, needs a financial_workflows row to resume at
 * whichever step failed), an order has exactly one charge. Per this
 * codebase's own established rule (see
 * 20260802000001_financial_workflow_schema.sql's header comment): single
 * provider-call operations don't get a workflow row, they're already
 * safely idempotent via idempotency_keys and the payment row's own
 * status -- this mirrors captureDeposit()/releaseDeposit()'s shape, not
 * authorizeBookingFinancials()'s.
 *
 * Reuses provider.chargeRental() -- functionally identical to what an
 * order needs (authorize + capture a one-time charge in one call); the
 * PaymentProvider interface has no separate "chargeOrder" method and
 * adding one would duplicate chargeRental()'s exact contract for no
 * behavioral difference.
 */
export async function chargeOrderPayment(
  ctx: OrchestratorContext,
  orderId: string,
  idempotencyKey?: string
): Promise<ChargeOrderPaymentResult> {
  const { admin } = ctx
  const providerName = ctx.providerName || process.env.PAYMENT_PROVIDER || 'mock'
  const provider = getPaymentProvider(providerName)

  const { paymentId } = await prepareOrderFinancials(ctx, orderId, idempotencyKey)

  const { data: payment } = await admin.from('payments').select('status, provider_reference').eq('id', paymentId).maybeSingle()
  if (payment?.status === 'captured') {
    // Step 11 Phase 7: re-attempted on every replay, not just the first
    // capture -- qualify_sale_affiliate_commission() is itself idempotent,
    // and this also covers a prior call that captured the payment but
    // crashed before reaching qualification.
    await qualifySaleAffiliateCommission(admin, orderId, paymentId)
    return { paymentId, status: 'captured', orderStatus: 'paid' }
  }

  try {
    // testRentalScenario is reused here (not a new order-specific field
    // on OrchestratorContext) -- it already means exactly "the mock
    // scenario for the one charge this workflow makes", true for both
    // a booking's rental charge and an order's purchase charge.
    const charge = await provider.chargeRental({
      paymentId,
      providerReference: payment?.provider_reference ?? '',
      amount: 0,
      currency: 'ZAR',
      mockScenario: ctx.testRentalScenario,
    })

    await admin.rpc('record_payment_attempt', {
      p_payment_id: paymentId,
      p_attempt_number: 1,
      p_provider: provider.name,
      p_status: charge.status === 'captured' ? 'succeeded' : 'failed',
      p_provider_reference: charge.providerReference,
      // Step 11 Phase 6: a normalized, closed-vocabulary code (never raw
      // provider text) so admin/CSV/email surfaces can display a safe
      // category -- see docs/ORDER_ADMINISTRATION.md, "failure category".
      p_failure_code: charge.status === 'failed' ? 'provider_declined' : null,
      p_failure_message: charge.failureReason ?? null,
    })

    if (charge.status === 'failed') {
      await admin.rpc('transition_payment_status', {
        p_payment_id: paymentId,
        p_new_status: 'failed',
        p_failure_reason: charge.failureReason ?? 'order payment declined',
        p_actor_type: 'system',
      })
      throw new OrchestrationError('provider_declined', charge.failureReason ?? 'Payment was declined')
    }

    await admin.rpc('transition_payment_status', {
      p_payment_id: paymentId,
      p_new_status: 'captured',
      p_provider_reference: charge.providerReference,
      p_actor_type: 'system',
    })

    const { error: markPaidError } = await admin.rpc('mark_order_paid', {
      p_order_id: orderId,
      p_payment_id: paymentId,
      p_idempotency_key: idempotencyKey ? `${idempotencyKey}-paid` : null,
    })
    if (markPaidError) {
      throw new OrchestrationError('internal_consistency_error', `Payment captured but order could not be marked paid: ${markPaidError.message}`)
    }

    // Step 11 Phase 7: affiliate commission qualification is best-effort
    // and never throws -- a qualification failure must never roll back
    // or fail the customer's own payment (Part J).
    await qualifySaleAffiliateCommission(admin, orderId, paymentId)

    return { paymentId, status: 'captured', orderStatus: 'paid' }
  } catch (err) {
    if (err instanceof OrchestrationError) throw err

    let code: OrchestrationErrorCode = 'internal_consistency_error'
    if (err instanceof ProviderTimeoutError) code = 'provider_timeout'
    else if (err instanceof RetryableProviderError) code = 'retryable_provider_error'
    else if (err instanceof TerminalProviderError) code = 'terminal_provider_error'

    throw new OrchestrationError(code, err instanceof Error ? err.message : String(err))
  }
}
