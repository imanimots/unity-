import type { OrchestratorContext } from './types'
import { OrchestrationError } from './errors'
import { getActivePaymentProvider, assertProviderSupportsCapability, ProviderNotPermittedError } from '../registry'
import { ProviderCapabilityUnsupportedError } from '../provider'
import { isPayoutExecutionEnabled } from '../payout-execution/gate'
import { resolvePayoutDestinationDetails, buildReferenceForAttempt, classifyProviderCallError } from './payout-provider-attempt-shared'

export interface ExecuteAffiliatePayoutProviderAttemptResult {
  attemptId: string
  providerPayoutId: string
  outcome: 'submitted' | 'ambiguous'
  status?: string
  ambiguousReason?: string
}

/**
 * E33: mirrors executeMerchantPayoutProviderAttempt exactly -- see that
 * file's own comment for the full ordering rationale and the ambiguous-
 * outcome handling. The internal affiliate cron (process-payouts/
 * route.ts) is the real caller; it is responsible for the E32
 * destination-eligibility PRECHECK before even calling this (phase
 * brief §58) -- start_affiliate_payout_provider_attempt re-checks it
 * again regardless (defense in depth, not a substitute).
 */
export async function executeAffiliatePayoutProviderAttempt(ctx: OrchestratorContext, commissionId: string): Promise<ExecuteAffiliatePayoutProviderAttemptResult> {
  const { admin, providerName, testPayoutScenario } = ctx

  if (!isPayoutExecutionEnabled()) {
    throw new OrchestrationError('provider_configuration_error', 'Peach payout execution is not enabled in this environment')
  }

  let provider
  try {
    provider = getActivePaymentProvider(providerName)
    assertProviderSupportsCapability(provider, 'affiliate_payout')
  } catch (err) {
    if (err instanceof ProviderNotPermittedError || err instanceof ProviderCapabilityUnsupportedError) {
      throw new OrchestrationError('provider_configuration_error', err.message)
    }
    throw err
  }

  const { data: startData, error: startError } = await admin.rpc('start_affiliate_payout_provider_attempt', {
    p_commission_id: commissionId,
  })
  if (startError) throw new OrchestrationError('invalid_payment_transition', startError.message)

  const started = startData as { attempt_id: string; provider_payout_id: string; destination_id: string; amount: number; amount_minor_units: number; currency: string }

  const details = await resolvePayoutDestinationDetails(admin, started.destination_id)
  const reference = buildReferenceForAttempt(started.attempt_id)

  const { data: commission } = await admin.from('affiliate_commissions').select('affiliate_id').eq('id', commissionId).maybeSingle()

  try {
    const result = await provider.createAffiliatePayout({
      affiliateId: commission?.affiliate_id ?? '',
      commissionId,
      payoutId: started.provider_payout_id,
      reference,
      amount: started.amount,
      amountMinorUnits: started.amount_minor_units,
      currency: started.currency,
      bankName: details.bankName,
      branchCode: details.branchCode,
      accountNumber: details.accountNumber,
      accountHolder: details.accountHolder,
      mockScenario: testPayoutScenario,
    })

    const { error: completeError } = await admin.rpc('complete_affiliate_payout_provider_attempt', {
      p_attempt_id: started.attempt_id,
      p_provider_status: result.status,
      p_result_code: result.resultCode ?? null,
      p_provider_request_id: result.providerRequestId ?? null,
      p_source: 'create_response',
    })
    if (completeError) throw new OrchestrationError('internal_consistency_error', completeError.message)

    return { attemptId: started.attempt_id, providerPayoutId: started.provider_payout_id, outcome: 'submitted', status: result.status }
  } catch (err) {
    if (err instanceof OrchestrationError) throw err

    const classification = classifyProviderCallError(err)
    if (classification.terminal) {
      const { error: completeError } = await admin.rpc('complete_affiliate_payout_provider_attempt', {
        p_attempt_id: started.attempt_id,
        p_provider_status: 'failed',
        p_result_code: null,
        p_provider_request_id: null,
        p_source: 'create_response',
      })
      if (completeError) throw new OrchestrationError('internal_consistency_error', completeError.message)
      return { attemptId: started.attempt_id, providerPayoutId: started.provider_payout_id, outcome: 'submitted', status: 'failed' }
    }

    return { attemptId: started.attempt_id, providerPayoutId: started.provider_payout_id, outcome: 'ambiguous', ambiguousReason: classification.reason }
  }
}
