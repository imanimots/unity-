import type { OrchestratorContext } from './types'
import { OrchestrationError, type OrchestrationErrorCode } from './errors'
import { checkIdempotentReplay, computeAuthorizeBarterDepositHash } from './idempotency'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'
import { getPaymentProvider } from '../registry'

const ELIGIBLE_AGREEMENT_STATUSES = ['accepted']

export interface AuthorizeBarterDepositResult {
  paymentId: string
  status: string
}

/**
 * Single provider call, single payment transition -- mirrors
 * ensureDepositAuthorised()'s inline shape from
 * authorize-booking-financials.ts, but as its own top-level export: a
 * barter deposit is never part of a combined multi-step workflow the
 * way a booking's rental-charge-then-deposit sequence is, so it needs
 * no financial_workflows row -- the same "single provider call doesn't
 * need a workflow row" reasoning releaseDeposit()/captureDeposit()
 * already establish. Scoped by agreement + payer (not booking), since a
 * two-sided deposit has two independent payment rows for the same
 * agreement (see payments_barter_type_payer_unique).
 */
export async function authorizeBarterDeposit(
  ctx: OrchestratorContext,
  agreementId: string,
  payerId: string,
  idempotencyKey?: string
): Promise<AuthorizeBarterDepositResult> {
  const { admin, providerName = 'mock' } = ctx
  const provider = getPaymentProvider(providerName)

  const { data: deposit } = await admin
    .from('payments')
    .select('id, status, provider_reference')
    .eq('barter_agreement_id', agreementId)
    .eq('payment_type', 'barter_deposit')
    .eq('renter_id', payerId)
    .maybeSingle()

  if (!deposit) throw new OrchestrationError('missing_payment', 'No deposit payment is required from you on this agreement')

  // Checked before the agreement-eligibility gate below: a retry of an
  // already-successful payment (e.g. a network retry replaying the same
  // idempotency key) must still succeed even though the agreement has
  // since progressed past 'accepted' -- which happens precisely BECAUSE
  // this payment already succeeded. Gating on agreement status first
  // would incorrectly reject a legitimate replay of completed work.
  if (deposit.status === 'authorised' || deposit.status === 'captured' || deposit.status === 'released') {
    return { paymentId: deposit.id, status: deposit.status }
  }

  const { data: agreement } = await admin.from('barter_agreements').select('id, status').eq('id', agreementId).maybeSingle()
  if (!agreement) throw new OrchestrationError('missing_payment', 'Barter agreement not found')
  if (!ELIGIBLE_AGREEMENT_STATUSES.includes(agreement.status)) {
    throw new OrchestrationError('invalid_booking_state', `Barter agreement status "${agreement.status}" is not eligible for a deposit payment`)
  }

  const hash = computeAuthorizeBarterDepositHash(deposit.id)
  if (idempotencyKey) {
    const replay = await checkIdempotentReplay(admin, payerId, 'orchestrator_authorize_barter_deposit', idempotencyKey, hash)
    if (replay.status === 'replay') return replay.result as AuthorizeBarterDepositResult
    if (replay.status === 'conflict') throw new OrchestrationError('duplicate_workflow_conflict', 'This deposit request was already submitted with different data')
  }

  if (deposit.status !== 'pending') {
    throw new OrchestrationError('invalid_payment_transition', `Deposit payment is "${deposit.status}", not eligible for authorization`)
  }

  try {
    const auth = await provider.authorizeDeposit({
      paymentId: deposit.id,
      providerReference: deposit.provider_reference ?? '',
      amount: 0,
      currency: 'ZAR',
      mockScenario: ctx.testDepositScenario,
    })

    await admin.rpc('record_payment_attempt', {
      p_payment_id: deposit.id,
      p_attempt_number: 1,
      p_provider: provider.name,
      p_status: auth.status === 'authorised' ? 'succeeded' : 'failed',
      p_provider_reference: auth.providerReference,
      p_failure_message: auth.failureReason ?? null,
    })

    if (auth.status === 'failed') {
      await admin.rpc('transition_payment_status', {
        p_payment_id: deposit.id,
        p_new_status: 'failed',
        p_failure_reason: auth.failureReason ?? 'deposit authorization declined',
        p_actor_type: 'system',
      })
      throw new OrchestrationError('provider_declined', auth.failureReason ?? 'Deposit authorization was declined')
    }

    await admin.rpc('transition_payment_status', {
      p_payment_id: deposit.id,
      p_new_status: 'authorised',
      p_provider_reference: auth.providerReference,
      p_actor_type: 'system',
    })

    const result: AuthorizeBarterDepositResult = { paymentId: deposit.id, status: 'authorised' }

    if (idempotencyKey) {
      await admin.from('idempotency_keys').insert({
        merchant_id: payerId,
        operation: 'orchestrator_authorize_barter_deposit',
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
