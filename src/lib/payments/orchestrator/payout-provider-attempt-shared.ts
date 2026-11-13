import type { SupabaseClient } from '@supabase/supabase-js'
import { OrchestrationError } from './errors'
import { buildPayoutReference, buildAccountHolder } from '../providers/peach/payout-fields'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'

/**
 * E33: shared logic between executeMerchantPayoutProviderAttempt and
 * executeAffiliatePayoutProviderAttempt -- resolving destination/
 * identity details into the exact fields Peach's create-payout call
 * needs, and classifying a provider-call failure into "ambiguous,
 * leave in processing for reconciliation" vs "authoritative rejection,
 * safe to mark failed immediately" (phase brief §49/§50/§60). Kept out
 * of both call sites so the safety-critical error classification has
 * exactly one implementation, not two that could drift apart.
 */

export interface ResolvedPayoutDestinationDetails {
  accountNumber: string
  branchCode: string
  bankName: string
  accountHolder: string
}

/**
 * Pulls the raw account number (via the E32 service-role-only RPC),
 * the branch code already snapshotted on the destination row, the
 * confirmed Peach bankName mapping, and a fresh (never stale-cached)
 * account-holder name built from the owner's APPROVED, structured KYC
 * identity -- never from an editable profile display field (phase
 * brief §23). Fails closed (throws OrchestrationError) if identity is
 * not currently approved, even if it was approved when the
 * destination's BANV was originally submitted.
 */
export async function resolvePayoutDestinationDetails(admin: SupabaseClient, destinationId: string): Promise<ResolvedPayoutDestinationDetails> {
  const { data: destination, error: destError } = await admin
    .from('payout_destinations')
    .select('owner_id, universal_branch_code, bank_code')
    .eq('id', destinationId)
    .maybeSingle()
  if (destError) throw new OrchestrationError('internal_consistency_error', destError.message)
  if (!destination) throw new OrchestrationError('missing_payment', 'Payout destination not found')

  const { data: bank, error: bankError } = await admin.from('payout_banks').select('peach_payout_bank_name').eq('bank_code', destination.bank_code).maybeSingle()
  if (bankError) throw new OrchestrationError('internal_consistency_error', bankError.message)
  if (!bank?.peach_payout_bank_name) {
    throw new OrchestrationError('provider_configuration_error', 'Destination bank has no confirmed Peach payout bankName mapping')
  }

  const { data: identity, error: identityError } = await admin
    .from('identity_verifications')
    .select('status, legal_first_name, legal_surname')
    .eq('user_id', destination.owner_id)
    .maybeSingle()
  if (identityError) throw new OrchestrationError('internal_consistency_error', identityError.message)
  if (!identity || identity.status !== 'approved' || !identity.legal_first_name || !identity.legal_surname) {
    throw new OrchestrationError('missing_payment', 'Destination owner identity verification is not currently approved')
  }

  const { data: accountNumber, error: accountNumberError } = await admin.rpc('get_payout_destination_account_number', { p_destination_id: destinationId })
  if (accountNumberError) throw new OrchestrationError('internal_consistency_error', accountNumberError.message)

  return {
    accountNumber: accountNumber as string,
    branchCode: destination.universal_branch_code,
    bankName: bank.peach_payout_bank_name,
    accountHolder: buildAccountHolder(identity.legal_first_name, identity.legal_surname),
  }
}

export function buildReferenceForAttempt(attemptId: string): string {
  return buildPayoutReference(attemptId)
}

export type ProviderCallErrorClassification = { terminal: true; reason: string } | { terminal: false; reason: string }

/**
 * Classifies the result of a single provider.create*Payout() call that
 * THREW (as opposed to returning normally). ProviderTimeoutError /
 * RetryableProviderError / an unrecognized thrown error are all
 * AMBIGUOUS (terminal: false) -- Peach may have received the payout
 * even though this process never saw a clean response (phase brief
 * §45/§49). Only a TerminalProviderError (an authoritative 4xx
 * rejection) is terminal: true, proof the payout was never accepted.
 * An ambiguous classification is never auto-resolved by the caller --
 * the attempt is left in 'pending'/'processing' and relies on query
 * reconciliation (by the same provider_payout_id, never a new one).
 */
export function classifyProviderCallError(err: unknown): ProviderCallErrorClassification {
  if (err instanceof TerminalProviderError) return { terminal: true, reason: err.message }
  if (err instanceof ProviderTimeoutError) return { terminal: false, reason: 'provider_timeout' }
  if (err instanceof RetryableProviderError) return { terminal: false, reason: 'retryable_provider_error' }
  return { terminal: false, reason: err instanceof Error ? err.message : 'unknown error' }
}

const PAYOUT_STATUSES = ['pending', 'processing', 'successful', 'failed', 'cancelled', 'reversed'] as const

export interface ApplyPayoutWebhookResult {
  ok: boolean
  domainTransitioned: boolean
}

/**
 * E33: applies an already signature-verified Peach Payouts webhook
 * payload (POST /payments/webhooks/peach-payouts). Looks up the
 * attempt by (provider, provider_payout_id) to learn which domain RPC
 * owns it, then calls the SAME shared "apply provider truth" authority
 * the create-response path and query reconciliation both use. Fails
 * closed (returns null) on an unrecognized shape or an unknown
 * payoutId -- never guesses, never marks anything.
 */
export async function applyPayoutWebhookPayload(admin: SupabaseClient, rawPayload: unknown): Promise<ApplyPayoutWebhookResult | null> {
  if (!rawPayload || typeof rawPayload !== 'object') return null
  const body = rawPayload as Record<string, unknown>
  const payoutId = body.payoutId
  const status = body.status
  if (typeof payoutId !== 'string' || typeof status !== 'string' || !(PAYOUT_STATUSES as readonly string[]).includes(status)) return null
  const resultCode = typeof body.resultCode === 'string' ? body.resultCode : null
  const lastUpdated = typeof body.lastUpdated === 'string' ? body.lastUpdated : null

  const { data: attempt, error: attemptError } = await admin
    .from('payout_provider_attempts')
    .select('id, merchant_payout_id')
    .eq('provider', 'peach')
    .eq('provider_payout_id', payoutId)
    .maybeSingle()
  if (attemptError) throw new OrchestrationError('internal_consistency_error', attemptError.message)
  if (!attempt) return null

  const rpcName = attempt.merchant_payout_id ? 'complete_merchant_payout_provider_attempt' : 'complete_affiliate_payout_provider_attempt'
  const { data, error } = await admin.rpc(rpcName, {
    p_attempt_id: attempt.id,
    p_provider_status: status,
    p_result_code: resultCode,
    p_provider_request_id: null,
    p_provider_last_updated_at: lastUpdated,
    p_source: 'webhook',
  })
  if (error) throw new OrchestrationError('internal_consistency_error', error.message)

  const result = data as { ok: boolean; domain_transitioned?: boolean }
  return { ok: result.ok, domainTransitioned: Boolean(result.domain_transitioned) }
}
