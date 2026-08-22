import type { OrchestratorContext } from './types'
import { OrchestrationError, type OrchestrationErrorCode } from './errors'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'
import { getPaymentProvider } from '../registry'

export interface ChargeRentToBuyDepositResult {
  paymentId: string
  status: 'captured'
}

/**
 * The security deposit is charged as its own, independent, single-shot
 * payment -- never counted toward purchase progress, never commissioned
 * (Rule 10-12). record_rent_to_buy_deposit_payment() sets
 * deposit_funded_at (the Rule 12 handover gate) and re-checks possession
 * eligibility; it never touches rent_to_buy_installments or
 * ownership_status. Deliberately NOT wired through escrow_transactions --
 * the deposit is a genuinely separate pool from purchase escrow (Rule
 * 28), tracked instead via the agreement's own deposit_funded_at/
 * deposit_forfeited_at/deposit_refunded_at columns and settled by the
 * V2 settlement helpers directly; giving it its own escrow row would
 * make it indistinguishable from purchase-proceeds rows to the generic
 * settlement sweep, risking exactly the "auto-convert deposit into
 * purchase payment" outcome Rule 12 prohibits.
 */
export async function chargeRentToBuyDeposit(
  ctx: OrchestratorContext,
  agreementId: string,
  idempotencyKey?: string
): Promise<ChargeRentToBuyDepositResult> {
  const { admin } = ctx
  const providerName = ctx.providerName || process.env.PAYMENT_PROVIDER || 'mock'
  const provider = getPaymentProvider(providerName)

  const { data: agreement, error: agreementError } = await admin
    .from('rent_to_buy_agreements')
    .select('id, merchant_id, customer_id, currency, security_deposit_amount')
    .eq('id', agreementId)
    .maybeSingle()
  if (agreementError || !agreement) throw new OrchestrationError('missing_payment', 'Rent-to-buy agreement not found')
  if (!agreement.security_deposit_amount) throw new OrchestrationError('invalid_booking_state', 'This agreement has no security deposit configured')

  const { data: existing } = await admin.from('payments').select('id, status').eq('rent_to_buy_agreement_id', agreementId).eq('payment_type', 'rent_to_buy_deposit').maybeSingle()
  if (existing?.status === 'captured') return { paymentId: existing.id, status: 'captured' }

  let paymentId = existing?.id
  if (!paymentId) {
    const { data: intent, error: intentError } = await admin.rpc('create_rent_to_buy_payment_intent', {
      p_rent_to_buy_agreement_id: agreementId,
      p_payer_id: agreement.customer_id,
      p_counterparty_id: agreement.merchant_id,
      p_payment_type: 'rent_to_buy_deposit',
      p_amount: agreement.security_deposit_amount,
      p_currency: agreement.currency,
      p_provider: providerName,
      p_idempotency_key: idempotencyKey ? `${idempotencyKey}-intent` : null,
    })
    if (intentError) throw new OrchestrationError('internal_consistency_error', `Could not create deposit payment: ${intentError.message}`)
    paymentId = intent.payment_id as string
  }

  try {
    const charge = await provider.authorizeDeposit({
      paymentId,
      providerReference: '',
      amount: 0,
      currency: 'ZAR',
      mockScenario: ctx.testDepositScenario,
    })

    await admin.rpc('record_payment_attempt', {
      p_payment_id: paymentId,
      p_attempt_number: 1,
      p_provider: provider.name,
      p_status: charge.status === 'authorised' ? 'succeeded' : 'failed',
      p_provider_reference: charge.providerReference,
      p_failure_code: charge.status === 'failed' ? 'provider_declined' : null,
      p_failure_message: charge.failureReason ?? null,
    })

    if (charge.status === 'failed') {
      await admin.rpc('transition_payment_status', {
        p_payment_id: paymentId,
        p_new_status: 'failed',
        p_failure_reason: charge.failureReason ?? 'deposit payment declined',
        p_actor_type: 'system',
      })
      throw new OrchestrationError('provider_declined', charge.failureReason ?? 'Deposit payment was declined')
    }

    await admin.rpc('transition_payment_status', {
      p_payment_id: paymentId,
      p_new_status: 'captured',
      p_provider_reference: charge.providerReference,
      p_actor_type: 'system',
    })

    const { error: recordError } = await admin.rpc('record_rent_to_buy_deposit_payment', {
      p_agreement_id: agreementId,
      p_payment_id: paymentId,
      p_idempotency_key: idempotencyKey ? `${idempotencyKey}-record` : null,
    })
    if (recordError) {
      throw new OrchestrationError('internal_consistency_error', `Deposit captured but could not be recorded: ${recordError.message}`)
    }

    return { paymentId, status: 'captured' }
  } catch (err) {
    if (err instanceof OrchestrationError) throw err

    let code: OrchestrationErrorCode = 'internal_consistency_error'
    if (err instanceof ProviderTimeoutError) code = 'provider_timeout'
    else if (err instanceof RetryableProviderError) code = 'retryable_provider_error'
    else if (err instanceof TerminalProviderError) code = 'terminal_provider_error'

    throw new OrchestrationError(code, err instanceof Error ? err.message : String(err))
  }
}
