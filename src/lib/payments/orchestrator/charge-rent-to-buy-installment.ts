import type { OrchestratorContext } from './types'
import { OrchestrationError, type OrchestrationErrorCode } from './errors'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'
import { getPaymentProvider } from '../registry'
import { createEscrowForPayment, fundEscrowForPayment } from '@/lib/escrow/orchestrator'

export interface ChargeRentToBuyInstallmentResult {
  paymentId: string
  status: 'captured'
  installmentId: string
}

/**
 * Single-step charge for one scheduled instalment -- mirrors
 * chargeOrderPayment()'s shape exactly (one provider call, no
 * financial_workflows row, idempotent via payments_rtb_deposit_unique/
 * the installment's own (agreement_id, sequence) uniqueness).
 *
 * V2: each captured instalment is escrow-governed like every other
 * held-funds domain (createEscrowForPayment/fundEscrowForPayment,
 * both no-ops when ESCROW_ENABLED is off -- fail-closed, never claims
 * real escrow protection when the capability is unavailable). RTB
 * commission is no longer qualified per-installment -- it is computed
 * once, at settlement (finalize_rent_to_buy_ownership /
 * the default/termination settlement helpers), using the RENTAL
 * commission rate snapshotted at acceptance, based on the actual
 * possession period -- never a per-payment sale/rental-style event.
 */
export async function chargeRentToBuyInstallment(
  ctx: OrchestratorContext,
  agreementId: string,
  sequence: number,
  idempotencyKey?: string
): Promise<ChargeRentToBuyInstallmentResult> {
  const { admin } = ctx
  const providerName = ctx.providerName || process.env.PAYMENT_PROVIDER || 'mock'
  const provider = getPaymentProvider(providerName)

  const { data: agreement, error: agreementError } = await admin
    .from('rent_to_buy_agreements')
    .select('id, merchant_id, customer_id, currency, status')
    .eq('id', agreementId)
    .maybeSingle()
  if (agreementError || !agreement) throw new OrchestrationError('missing_payment', 'Rent-to-buy agreement not found')

  const { data: installment, error: installmentError } = await admin
    .from('rent_to_buy_installments')
    .select('id, sequence, principal_amount, status, payment_id')
    .eq('agreement_id', agreementId)
    .eq('sequence', sequence)
    .maybeSingle()
  if (installmentError || !installment) throw new OrchestrationError('missing_payment', 'Instalment not found')

  if (installment.status === 'paid') {
    return { paymentId: installment.payment_id as string, status: 'captured', installmentId: installment.id }
  }

  const { data: intent, error: intentError } = await admin.rpc('create_rent_to_buy_payment_intent', {
    p_rent_to_buy_agreement_id: agreementId,
    p_payer_id: agreement.customer_id,
    p_counterparty_id: agreement.merchant_id,
    p_payment_type: 'rent_to_buy_installment',
    p_amount: installment.principal_amount,
    p_currency: agreement.currency,
    p_provider: providerName,
    p_idempotency_key: idempotencyKey ? `${idempotencyKey}-intent-${sequence}` : null,
  })
  if (intentError) throw new OrchestrationError('internal_consistency_error', `Could not create instalment payment: ${intentError.message}`)
  const paymentId = intent.payment_id as string

  try {
    const charge = await provider.chargeRental({
      paymentId,
      providerReference: '',
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
      p_failure_code: charge.status === 'failed' ? 'provider_declined' : null,
      p_failure_message: charge.failureReason ?? null,
    })

    if (charge.status === 'failed') {
      await admin.rpc('transition_payment_status', {
        p_payment_id: paymentId,
        p_new_status: 'failed',
        p_failure_reason: charge.failureReason ?? 'instalment payment declined',
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

    const { error: recordError } = await admin.rpc('record_rent_to_buy_installment_payment', {
      p_agreement_id: agreementId,
      p_sequence: sequence,
      p_payment_id: paymentId,
      p_idempotency_key: idempotencyKey ? `${idempotencyKey}-record-${sequence}` : null,
    })
    if (recordError) {
      throw new OrchestrationError('internal_consistency_error', `Payment captured but instalment could not be recorded: ${recordError.message}`)
    }

    try {
      await createEscrowForPayment(admin, {
        transactionType: 'rent_to_buy',
        rentToBuyAgreementId: agreementId,
        paymentId,
        principalAmount: Number(installment.principal_amount),
        currency: agreement.currency,
      })
      await fundEscrowForPayment(admin, paymentId)
    } catch (escrowErr) {
      // Best-effort, matches every other domain's own escrow wiring --
      // never blocks an already-captured payment. Escrow accounting
      // integrity is verified separately by the settlement helpers,
      // which only ever act on rows that reached 'funded'.
      console.error('[rent-to-buy.charge-installment] escrow create/fund failed', { agreementId, installmentId: installment.id, escrowErr })
    }

    return { paymentId, status: 'captured', installmentId: installment.id }
  } catch (err) {
    if (err instanceof OrchestrationError) throw err

    let code: OrchestrationErrorCode = 'internal_consistency_error'
    if (err instanceof ProviderTimeoutError) code = 'provider_timeout'
    else if (err instanceof RetryableProviderError) code = 'retryable_provider_error'
    else if (err instanceof TerminalProviderError) code = 'terminal_provider_error'

    throw new OrchestrationError(code, err instanceof Error ? err.message : String(err))
  }
}
