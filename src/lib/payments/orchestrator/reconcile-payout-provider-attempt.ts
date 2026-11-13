import type { OrchestratorContext } from './types'
import { OrchestrationError } from './errors'
import { loadPeachPayoutsConfig } from '../providers/peach/payouts-config'
import { PeachPayoutsClient } from '../providers/peach/banv-client'

export interface ReconcilePayoutProviderAttemptResult {
  stillPending: boolean
  appliedStatus?: string
  domainTransitioned?: boolean
}

/**
 * E33: query-by-payoutId reconciliation (phase brief §46/§47/§62) --
 * for a missed/delayed webhook, or an attempt stuck without a known
 * outcome after a create-call timeout. Never submits a new payout;
 * only queries Peach's existing record for an already-known
 * provider_payout_id. Calls the SAME shared "apply provider truth" RPC
 * the webhook uses, with source='query_reconciliation', so there is
 * exactly one authority for what a Peach status means.
 *
 * Bypasses the generic PaymentProvider abstraction deliberately --
 * query-by-payoutId is Peach-specific, not a generic capability, same
 * precedent as reconcileBankVerification() in payout-destinations/
 * service.ts constructing PeachPayoutsClient directly.
 */
export async function reconcilePayoutProviderAttempt(ctx: OrchestratorContext, attemptId: string): Promise<ReconcilePayoutProviderAttemptResult> {
  const { admin } = ctx

  const { data: attempt, error: attemptError } = await admin
    .from('payout_provider_attempts')
    .select('provider, provider_payout_id, merchant_payout_id, affiliate_commission_id')
    .eq('id', attemptId)
    .maybeSingle()
  if (attemptError) throw new OrchestrationError('internal_consistency_error', attemptError.message)
  if (!attempt) throw new OrchestrationError('missing_payment', 'Provider attempt not found')

  const config = loadPeachPayoutsConfig()
  if (!config) throw new OrchestrationError('provider_configuration_error', 'Peach Payouts is not configured')
  const client = new PeachPayoutsClient(config)

  const result = await client.queryPayoutByPayoutId(attempt.provider_payout_id)
  if (!result) {
    // Per the live reference: "A 404 means it is not visible yet. Wait
    // and call this again." Never treated as proof the payout was
    // never received, and never triggers a resubmission here -- that
    // decision is explicitly out of this function's scope (phase
    // brief §47: only an explicit, bounded, admin-visible policy may
    // ever permit a same-provider_payout_id resubmission).
    return { stillPending: true }
  }

  const rpcName = attempt.merchant_payout_id ? 'complete_merchant_payout_provider_attempt' : 'complete_affiliate_payout_provider_attempt'
  const { data: completeData, error: completeError } = await admin.rpc(rpcName, {
    p_attempt_id: attemptId,
    p_provider_status: result.status,
    p_result_code: result.resultCode || null,
    p_provider_request_id: null,
    p_provider_last_updated_at: result.lastUpdated,
    p_source: 'query_reconciliation',
  })
  if (completeError) throw new OrchestrationError('internal_consistency_error', completeError.message)

  const applied = completeData as { domain_transitioned?: boolean }
  return { stillPending: false, appliedStatus: result.status, domainTransitioned: Boolean(applied?.domain_transitioned) }
}
