import type { SupabaseClient } from '@supabase/supabase-js'
import { isPayoutExecutionEnabled } from './gate'
import { loadPeachPayoutsConfig } from '../providers/peach/payouts-config'

/**
 * E34 (phase brief §46): one authoritative, server-only readiness
 * function. Every field is a safe boolean/status/string -- never a
 * secret value, never a raw credential. Several fields cannot be
 * verified by code at all (Peach's Payouts-product-activation and
 * source-of-funds sign-off are operational facts that live on Peach's
 * own Dashboard/support relationship, confirmed this phase to have no
 * API -- see docs/PEACH_INTEGRATION.md §20) -- those are reported
 * 'unknown' unless an explicit, separately-set operational-attestation
 * env var says otherwise. Credentials existing is explicitly NOT
 * treated as proof of either (phase brief §44's own instruction).
 */

export type ReadinessStatus = 'yes' | 'no' | 'unknown'

export interface PeachPayoutActivationReadiness {
  executionGateConfigured: boolean
  credentialsPresent: boolean
  productActivationConfirmed: ReadinessStatus
  sourceOfFundsConfirmed: ReadinessStatus
  webhookConfigured: ReadinessStatus
  webhookSigningConfigured: boolean
  destinationAuthorityHealthy: boolean
  providerClientHealthy: boolean
  sandboxCertified: boolean
  sandboxCertificationBlockedReason: string | null
  productionCanaryApproved: boolean
}

function readExactTrueFalse(value: string | undefined): ReadinessStatus {
  if (value === 'true') return 'yes'
  if (value === 'false') return 'no'
  return 'unknown'
}

export async function getPeachPayoutActivationReadiness(admin: SupabaseClient, env: NodeJS.ProcessEnv = process.env): Promise<PeachPayoutActivationReadiness> {
  const executionGateConfigured = isPayoutExecutionEnabled(env)

  let credentialsPresent = false
  let providerClientHealthy = false
  try {
    const config = loadPeachPayoutsConfig(env)
    credentialsPresent = config !== null
    providerClientHealthy = config !== null
  } catch {
    // Partially-set credentials (loadPeachPayoutsConfig throws) --
    // neither fully present nor healthy.
    credentialsPresent = false
    providerClientHealthy = false
  }

  const webhookSigningConfigured = Boolean(env.PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET && env.PEACH_PAYOUTS_WEBHOOK_SIGNING_SECRET.trim())

  // Dashboard-only configuration, confirmed this phase to have no API
  // (developer.peachpayments.com/docs/reference-webhooks) -- code can
  // never verify the actual registered URL, only that a signing secret
  // was provisioned for this deployment to verify against.
  const webhookConfigured: ReadinessStatus = webhookSigningConfigured ? 'unknown' : 'no'

  const productActivationConfirmed = readExactTrueFalse(env.PEACH_PAYOUTS_PRODUCT_ACTIVE)
  const sourceOfFundsConfirmed = readExactTrueFalse(env.PEACH_SOURCE_OF_FUNDS_APPROVED)

  let destinationAuthorityHealthy = false
  try {
    const { error } = await admin.from('payout_banks').select('bank_code', { count: 'exact', head: true }).limit(1)
    destinationAuthorityHealthy = !error
  } catch {
    destinationAuthorityHealthy = false
  }

  // Sandbox certification is never self-reported true by this
  // function -- it is a fact about whether E34's own certification run
  // actually happened and is documented, never inferred live.
  const sandboxCertified = false
  const sandboxCertificationBlockedReason = credentialsPresent ? null : 'SANDBOX CREDENTIALS NOT AVAILABLE'

  // No canary-approval mechanism exists anywhere in this codebase by
  // design (phase brief §49) -- always false, there is no env var or
  // DB row that can ever flip this from E34.
  const productionCanaryApproved = false

  return {
    executionGateConfigured,
    credentialsPresent,
    productActivationConfirmed,
    sourceOfFundsConfirmed,
    webhookConfigured,
    webhookSigningConfigured,
    destinationAuthorityHealthy,
    providerClientHealthy,
    sandboxCertified,
    sandboxCertificationBlockedReason,
    productionCanaryApproved,
  }
}

/**
 * A single, conservative yes/no summary derived from the structured
 * readiness above -- never weakens any individual gate, only reports
 * whether every one of them is simultaneously satisfied (phase brief
 * §70: "do not conflate code-ready with production-ready").
 */
export function isProductionReady(readiness: PeachPayoutActivationReadiness): boolean {
  return (
    readiness.executionGateConfigured &&
    readiness.credentialsPresent &&
    readiness.productActivationConfirmed === 'yes' &&
    readiness.sourceOfFundsConfirmed === 'yes' &&
    readiness.webhookSigningConfigured &&
    readiness.destinationAuthorityHealthy &&
    readiness.providerClientHealthy &&
    readiness.sandboxCertified
  )
}
