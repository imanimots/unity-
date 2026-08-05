import type { OrchestratorContext } from './types'
import { OrchestrationError, type OrchestrationErrorCode } from './errors'
import { checkIdempotentReplay, computeChargeBarterCashAdjustmentHash } from './idempotency'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'
import { getPaymentProvider } from '../registry'

export interface ChargeBarterCashAdjustmentResult {
  paymentId: string
  status: 'captured'
}

const ELIGIBLE_AGREEMENT_STATUSES = ['accepted']

/**
 * Single-step charge, mirrors chargeOrderPayment() exactly -- reuses
 * provider.chargeRental() (no separate "chargeCashAdjustment" provider
 * method; functionally identical to a one-time charge, same reuse
 * precedent orders already established). Unlike an order, there is no
 * "mark paid" RPC to call afterward -- capturing the cash adjustment
 * doesn't itself move barter_agreements.status; that's
 * mark_barter_progress/confirm_barter_completion's concern.
 *
 * Checks the agreement's own status first (mirrors
 * authorizeBarterDeposit's own eligibility check) -- without this, a
 * disputed or cancelled agreement's still-'pending' cash-adjustment
 * intent could still be charged, which would violate "opening a
 * dispute freezes financial progression" (Part G).
 */
export async function chargeBarterCashAdjustment(
  ctx: OrchestratorContext,
  agreementId: string,
  payerId: string,
  idempotencyKey?: string
): Promise<ChargeBarterCashAdjustmentResult> {
  const { admin, providerName = 'mock' } = ctx
  const provider = getPaymentProvider(providerName)

  const { data: payment } = await admin
    .from('payments')
    .select('id, status, provider_reference')
    .eq('barter_agreement_id', agreementId)
    .eq('payment_type', 'barter_cash_adjustment')
    .eq('renter_id', payerId)
    .maybeSingle()

  if (!payment) throw new OrchestrationError('missing_payment', 'No cash adjustment payment is required from you on this agreement')

  // Checked before the agreement-eligibility gate below -- same
  // reasoning as authorizeBarterDeposit(): a retry of an
  // already-captured payment must still succeed even if the agreement
  // has since moved on.
  if (payment.status === 'captured') {
    return { paymentId: payment.id, status: 'captured' }
  }

  const { data: agreement } = await admin.from('barter_agreements').select('id, status').eq('id', agreementId).maybeSingle()
  if (!agreement) throw new OrchestrationError('missing_payment', 'Barter agreement not found')
  if (!ELIGIBLE_AGREEMENT_STATUSES.includes(agreement.status)) {
    throw new OrchestrationError('invalid_booking_state', `Barter agreement status "${agreement.status}" is not eligible for a cash adjustment payment`)
  }

  const hash = computeChargeBarterCashAdjustmentHash(payment.id)
  if (idempotencyKey) {
    const replay = await checkIdempotentReplay(admin, payerId, 'orchestrator_charge_barter_cash_adjustment', idempotencyKey, hash)
    if (replay.status === 'replay') return replay.result as ChargeBarterCashAdjustmentResult
    if (replay.status === 'conflict') throw new OrchestrationError('duplicate_workflow_conflict', 'This payment request was already submitted with different data')
  }

  if (payment.status !== 'pending') {
    throw new OrchestrationError('invalid_payment_transition', `Cash adjustment payment is "${payment.status}", not eligible for charge`)
  }

  try {
    const charge = await provider.chargeRental({
      paymentId: payment.id,
      providerReference: payment.provider_reference ?? '',
      amount: 0,
      currency: 'ZAR',
      mockScenario: ctx.testRentalScenario,
    })

    await admin.rpc('record_payment_attempt', {
      p_payment_id: payment.id,
      p_attempt_number: 1,
      p_provider: provider.name,
      p_status: charge.status === 'captured' ? 'succeeded' : 'failed',
      p_provider_reference: charge.providerReference,
      p_failure_message: charge.failureReason ?? null,
    })

    if (charge.status === 'failed') {
      await admin.rpc('transition_payment_status', {
        p_payment_id: payment.id,
        p_new_status: 'failed',
        p_failure_reason: charge.failureReason ?? 'cash adjustment payment declined',
        p_actor_type: 'system',
      })
      throw new OrchestrationError('provider_declined', charge.failureReason ?? 'Payment was declined')
    }

    await admin.rpc('transition_payment_status', {
      p_payment_id: payment.id,
      p_new_status: 'captured',
      p_provider_reference: charge.providerReference,
      p_actor_type: 'system',
    })

    const result: ChargeBarterCashAdjustmentResult = { paymentId: payment.id, status: 'captured' }

    if (idempotencyKey) {
      await admin.from('idempotency_keys').insert({
        merchant_id: payerId,
        operation: 'orchestrator_charge_barter_cash_adjustment',
        idempotency_key: idempotencyKey,
        request_hash: hash,
        result,
      })
    }

    return result
  } catch (err) {
    if (err instanceof OrchestrationError) throw err

    let code: OrchestrationErrorCode = 'internal_consistency_error'
    if (err instanceof ProviderTimeoutError) code = 'provider_timeout'
    else if (err instanceof RetryableProviderError) code = 'retryable_provider_error'
    else if (err instanceof TerminalProviderError) code = 'terminal_provider_error'

    throw new OrchestrationError(code, err instanceof Error ? err.message : String(err))
  }
}
