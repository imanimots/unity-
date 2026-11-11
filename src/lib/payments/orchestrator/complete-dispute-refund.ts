import type { OrchestratorContext } from './types'
import { OrchestrationError, type OrchestrationErrorCode } from './errors'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'
import { getPaymentProvider } from '../registry'
import { NotImplementedError } from '../provider'

export interface CompleteDisputeRefundResult {
  refundId: string
  status: 'completed' | 'failed'
  dispositionCompleted: boolean
  failureReason?: string
}

/**
 * E29: the only end-to-end-functional refund completion path --
 * PeachPaymentsProvider.refund() is still a stub (NotImplementedError),
 * and the live payments webhook route permanently defers every refund-
 * type provider event, so this synchronous admin-triggered call is what
 * MockProvider's own working refund() implementation, and any future
 * real provider, is actually exercised through.
 *
 * Two DB round trips bracket the one provider call:
 * start_refund_provider_attempt() (pending -> processing, migration
 * 20261111112418) immediately before it, record_refund_provider_result()
 * immediately after. Resumability is via the refund's own status, not
 * only the idempotency key (same convention as releaseDeposit):
 *   - already completed/failed: return the existing terminal result,
 *     never call the provider again.
 *   - already processing: refuse outright. There is no provider-side
 *     idempotency key in this abstraction's RefundInput today, so a
 *     refund stuck in 'processing' (the provider call started but this
 *     process crashed or lost the response before recording the
 *     result) must never be silently retried -- that risks a second,
 *     real economic refund if the first attempt actually succeeded at
 *     the provider. It is instead left for manual reconciliation (see
 *     the refund_provider_state_unknown exception category).
 */
export async function completeDisputeRefundWithProvider(
  ctx: OrchestratorContext,
  refundId: string,
  adminId: string,
  idempotencyKey?: string
): Promise<CompleteDisputeRefundResult> {
  const { admin, providerName } = ctx
  const provider = getPaymentProvider(providerName)

  const { data: refund } = await admin.from('refunds').select('id, payment_id, amount, reason, status').eq('id', refundId).maybeSingle()
  if (!refund) throw new OrchestrationError('missing_payment', 'Refund not found')

  if (refund.status === 'completed' || refund.status === 'failed') {
    return { refundId: refund.id, status: refund.status, dispositionCompleted: false }
  }
  if (refund.status === 'processing') {
    throw new OrchestrationError(
      'duplicate_workflow_conflict',
      'A refund attempt is already in progress for this refund -- verify its outcome with the payment provider before retrying'
    )
  }

  const { data: payment } = await admin.from('payments').select('id, provider_reference, currency').eq('id', refund.payment_id).maybeSingle()
  if (!payment) throw new OrchestrationError('missing_payment', 'Payment not found for this refund')

  const { error: startError } = await admin.rpc('start_refund_provider_attempt', {
    p_admin_id: adminId,
    p_refund_id: refund.id,
    p_idempotency_key: idempotencyKey ?? null,
  })
  if (startError) throw new OrchestrationError('invalid_payment_transition', startError.message)

  try {
    const result = await provider.refund({
      paymentId: payment.id,
      providerReference: payment.provider_reference ?? '',
      amount: Number(refund.amount),
      currency: payment.currency,
      reason: refund.reason ?? undefined,
    })

    const { data: recordResult, error: recordError } = await admin.rpc('record_refund_provider_result', {
      p_admin_id: adminId,
      p_refund_id: refund.id,
      p_provider_status: result.status,
      p_provider_reference: result.providerReference,
      p_failure_reason: result.status === 'failed' ? result.failureReason ?? null : null,
      p_idempotency_key: idempotencyKey ?? null,
    })
    if (recordError) throw new OrchestrationError('invalid_payment_transition', recordError.message)

    return {
      refundId: refund.id,
      status: result.status,
      dispositionCompleted: Boolean((recordResult as { disposition_completed?: boolean } | null)?.disposition_completed),
      failureReason: result.status === 'failed' ? result.failureReason : undefined,
    }
  } catch (err) {
    if (err instanceof OrchestrationError) throw err

    let code: OrchestrationErrorCode = 'internal_consistency_error'
    if (err instanceof ProviderTimeoutError) code = 'provider_timeout'
    else if (err instanceof RetryableProviderError) code = 'retryable_provider_error'
    else if (err instanceof TerminalProviderError) code = 'terminal_provider_error'
    else if (err instanceof NotImplementedError) code = 'provider_configuration_error'

    // The refund is deliberately left 'processing' here -- an honest,
    // visible intermediate state (see refund_provider_state_unknown)
    // rather than silently reverting to 'pending', which would let a
    // careless retry call the provider a second time for a request that
    // may, for all this orchestrator can know, already be in flight.
    throw new OrchestrationError(code, err instanceof Error ? err.message : String(err))
  }
}
