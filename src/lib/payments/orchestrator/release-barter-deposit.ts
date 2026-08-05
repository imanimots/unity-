import type { OrchestratorContext } from './types'
import { OrchestrationError } from './errors'
import { checkIdempotentReplay, computeReleaseBarterDepositHash } from './idempotency'
import { getPaymentProvider } from '../registry'

export interface ReleaseBarterDepositResult {
  paymentId: string
  status: 'released'
}

/**
 * Mirrors release-deposit.ts exactly, scoped by agreement + payer
 * instead of booking (a two-sided deposit has two independent payment
 * rows for the same agreement). Called after a successful completion
 * (Decision 9) or a 'refunded'-settlement cancellation (Decision 4) --
 * never from inside a SQL RPC, since a real release requires an actual
 * provider call.
 */
export async function releaseBarterDeposit(
  ctx: OrchestratorContext,
  agreementId: string,
  payerId: string,
  idempotencyKey?: string
): Promise<ReleaseBarterDepositResult> {
  const { admin, providerName = 'mock' } = ctx
  const provider = getPaymentProvider(providerName)

  const { data: deposit } = await admin
    .from('payments')
    .select('id, status, provider_reference')
    .eq('barter_agreement_id', agreementId)
    .eq('payment_type', 'barter_deposit')
    .eq('renter_id', payerId)
    .maybeSingle()

  if (!deposit) throw new OrchestrationError('missing_payment', 'No deposit payment exists for this agreement and payer')

  if (deposit.status === 'released') {
    return { paymentId: deposit.id, status: 'released' }
  }

  const hash = computeReleaseBarterDepositHash(deposit.id)
  if (idempotencyKey) {
    const replay = await checkIdempotentReplay(admin, payerId, 'orchestrator_release_barter_deposit', idempotencyKey, hash)
    if (replay.status === 'replay') return replay.result as ReleaseBarterDepositResult
    if (replay.status === 'conflict') throw new OrchestrationError('duplicate_workflow_conflict', 'This release request was already submitted with different data')
  }

  if (deposit.status !== 'authorised') {
    throw new OrchestrationError('invalid_payment_transition', `Deposit payment is "${deposit.status}", not eligible for release`)
  }

  const released = await provider.releaseDeposit({ paymentId: deposit.id, providerReference: deposit.provider_reference ?? '', amount: 0, currency: 'ZAR' })

  const { error } = await admin.rpc('transition_payment_status', {
    p_payment_id: deposit.id,
    p_new_status: 'released',
    p_provider_reference: released.providerReference,
    p_actor_type: 'system',
  })
  if (error) throw new OrchestrationError('invalid_payment_transition', error.message)

  const result: ReleaseBarterDepositResult = { paymentId: deposit.id, status: 'released' }

  if (idempotencyKey) {
    await admin.from('idempotency_keys').insert({
      merchant_id: payerId,
      operation: 'orchestrator_release_barter_deposit',
      idempotency_key: idempotencyKey,
      request_hash: hash,
      result,
    })
  }

  return result
}
