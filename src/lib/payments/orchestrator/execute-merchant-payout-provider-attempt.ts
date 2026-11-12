import type { OrchestratorContext } from './types'
import { OrchestrationError } from './errors'
import { getActivePaymentProvider, assertProviderSupportsCapability, ProviderNotPermittedError } from '../registry'
import { ProviderCapabilityUnsupportedError } from '../provider'
import { isPayoutExecutionEnabled, assertPeachEnvironmentConsistency } from '../payout-execution/gate'
import { loadPeachPayoutsConfig } from '../providers/peach/payouts-config'
import { resolvePayoutDestinationDetails, buildReferenceForAttempt, classifyProviderCallError } from './payout-provider-attempt-shared'

export interface ExecuteMerchantPayoutProviderAttemptResult {
  attemptId: string
  providerPayoutId: string
  outcome: 'submitted' | 'ambiguous'
  status?: string
  ambiguousReason?: string
}

/**
 * E33: the one entry point for real Peach merchant-payout execution.
 * Ordering (phase brief §52) is load-bearing -- each check below must
 * reject BEFORE the next step ever runs:
 *   1. dedicated payout-execution gate (independent of PAYMENT_PROVIDER)
 *   2. active provider + capability check
 *   3. start_merchant_payout_provider_attempt -- re-validates financial
 *      eligibility, currency authority, E32 destination eligibility,
 *      and binds the immutable destination snapshot, ALL atomically
 *      with the pending/failed -> processing transition
 *   4. resolve raw account number + fresh identity-sourced account
 *      holder name (never from this call's own cached config)
 *   5. the one real HTTP call to Peach
 *   6. complete_merchant_payout_provider_attempt -- the single shared
 *      "apply provider truth" authority, called with source=
 *      'create_response'
 *
 * A thrown, AMBIGUOUS provider error (timeout/retryable/unknown) never
 * calls step 6 -- the payout and its attempt are deliberately left in
 * 'processing' for query reconciliation by the same provider_payout_id
 * (phase brief §45/§49), never silently marked failed and never
 * retried automatically.
 */
export async function executeMerchantPayoutProviderAttempt(ctx: OrchestratorContext, payoutId: string, adminId: string): Promise<ExecuteMerchantPayoutProviderAttemptResult> {
  const { admin, providerName, testPayoutScenario } = ctx

  if (!isPayoutExecutionEnabled()) {
    throw new OrchestrationError('provider_configuration_error', 'Peach payout execution is not enabled in this environment')
  }

  let provider
  try {
    provider = getActivePaymentProvider(providerName)
    assertProviderSupportsCapability(provider, 'merchant_payout')
  } catch (err) {
    if (err instanceof ProviderNotPermittedError || err instanceof ProviderCapabilityUnsupportedError) {
      throw new OrchestrationError('provider_configuration_error', err.message)
    }
    throw err
  }

  // E34: app-environment vs Peach-environment consistency, before any
  // DB mutation (phase brief §51/§52) -- Peach-specific, since 'mock'
  // has no environment/host concept at all.
  if (provider.name === 'peach') {
    const peachConfig = loadPeachPayoutsConfig()
    if (!peachConfig) throw new OrchestrationError('provider_configuration_error', 'Peach Payouts is not configured')
    try {
      assertPeachEnvironmentConsistency(peachConfig.environment)
    } catch (err) {
      throw new OrchestrationError('provider_configuration_error', err instanceof Error ? err.message : String(err))
    }
  }

  const { data: startData, error: startError } = await admin.rpc('start_merchant_payout_provider_attempt', {
    p_admin_id: adminId,
    p_payout_id: payoutId,
  })
  if (startError) throw new OrchestrationError('invalid_payment_transition', startError.message)

  const started = startData as { attempt_id: string; provider_payout_id: string; destination_id: string; amount: number; amount_minor_units: number; currency: string }

  const details = await resolvePayoutDestinationDetails(admin, started.destination_id)
  const reference = buildReferenceForAttempt(started.attempt_id)

  const { data: payout } = await admin.from('merchant_payouts').select('merchant_id').eq('id', payoutId).maybeSingle()

  try {
    const result = await provider.createMerchantPayout({
      merchantId: payout?.merchant_id ?? '',
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

    const { error: completeError } = await admin.rpc('complete_merchant_payout_provider_attempt', {
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
      const { error: completeError } = await admin.rpc('complete_merchant_payout_provider_attempt', {
        p_attempt_id: started.attempt_id,
        p_provider_status: 'failed',
        p_result_code: null,
        p_provider_request_id: null,
        p_source: 'create_response',
      })
      if (completeError) throw new OrchestrationError('internal_consistency_error', completeError.message)
      return { attemptId: started.attempt_id, providerPayoutId: started.provider_payout_id, outcome: 'submitted', status: 'failed' }
    }

    // Ambiguous -- deliberately no RPC call here. The attempt and the
    // payout both remain 'processing'; reconciliation must query Peach
    // by started.provider_payout_id before anything else happens to
    // this payout.
    return { attemptId: started.attempt_id, providerPayoutId: started.provider_payout_id, outcome: 'ambiguous', ambiguousReason: classification.reason }
  }
}
