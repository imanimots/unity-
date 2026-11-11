import type { SupabaseClient } from '@supabase/supabase-js'
import { loadPeachPayoutsConfig } from '../providers/peach/payouts-config'
import { PeachPayoutsClient, parseBanvResultShape, type BanvStatus } from '../providers/peach/banv-client'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'
import { PayoutDestinationError } from './errors'

/**
 * E32: server-only orchestration for the payout-destination-authority
 * feature -- every function here requires a service-role Supabase
 * client, same convention as src/lib/payments/orchestrator/. Never
 * callable from a browser; the API route layer is responsible for
 * authenticating the caller and checking ownership/admin role before
 * invoking any of these.
 *
 * This phase does NOT implement payout execution -- nothing here ever
 * calls Peach's create-payout endpoint, and
 * getPayoutDestinationEligibility() exists only so a FUTURE phase has
 * one authoritative check to call before it would ever do so.
 */
export interface PayoutDestinationContext {
  admin: SupabaseClient
}

export interface AddPayoutDestinationResult {
  destinationId: string
  version: number
  verificationStatus: 'unverified'
}

export async function addPayoutDestination(
  ctx: PayoutDestinationContext,
  params: { ownerId: string; bankCode: string; accountNumber: string; accountType: string; actorId: string; actorType?: 'owner' | 'admin' }
): Promise<AddPayoutDestinationResult> {
  const { data, error } = await ctx.admin.rpc('create_payout_destination', {
    p_owner_id: params.ownerId,
    p_bank_code: params.bankCode,
    p_account_number: params.accountNumber,
    p_account_type: params.accountType,
    p_actor_id: params.actorId,
    p_actor_type: params.actorType ?? 'owner',
  })
  if (error) throw mapRpcError(error.message, 'invalid_input')

  const result = data as { destination_id: string; version: number; verification_status: 'unverified' }
  return { destinationId: result.destination_id, version: result.version, verificationStatus: result.verification_status }
}

export interface SubmitBankVerificationResult {
  attemptId: string
  providerVerificationId: string
  status: BanvStatus
}

/**
 * Sources idNumber/lastName live from identity_verifications --
 * requires status = 'approved' for the destination's owner, failing
 * closed with 'identity_not_approved' otherwise (never invents or
 * duplicates identity data, see docs comment in the migration).
 */
export async function submitBankVerification(
  ctx: PayoutDestinationContext,
  params: { destinationId: string; trigger: 'initial' | 'replacement' | 'reverification' | 'admin_manual'; actorId?: string; actorType?: 'owner' | 'admin' | 'system' }
): Promise<SubmitBankVerificationResult> {
  const { data: dest, error: destError } = await ctx.admin
    .from('payout_destinations')
    .select('id, owner_id, universal_branch_code, account_type')
    .eq('id', params.destinationId)
    .maybeSingle()
  if (destError) throw new PayoutDestinationError('internal_consistency_error', destError.message)
  if (!dest) throw new PayoutDestinationError('destination_not_found', 'Payout destination not found')

  const { data: identity, error: identityError } = await ctx.admin
    .from('identity_verifications')
    .select('status, id_reference_number, legal_surname')
    .eq('user_id', dest.owner_id)
    .maybeSingle()
  if (identityError) throw new PayoutDestinationError('internal_consistency_error', identityError.message)
  if (!identity || identity.status !== 'approved') {
    throw new PayoutDestinationError('identity_not_approved', 'Identity verification must be approved before bank account verification can be submitted')
  }

  const { data: startData, error: startError } = await ctx.admin.rpc('start_bank_verification_attempt', {
    p_destination_id: params.destinationId,
    p_trigger: params.trigger,
    p_actor_id: params.actorId ?? null,
    p_actor_type: params.actorType ?? 'owner',
  })
  if (startError) throw mapRpcError(startError.message, 'destination_not_current')
  const attemptId = (startData as { attempt_id: string }).attempt_id

  const config = loadPeachPayoutsConfig()
  if (!config) throw new PayoutDestinationError('provider_configuration_error', 'Peach Payouts is not configured')
  const client = new PeachPayoutsClient(config)

  const { data: accountNumber, error: accountNumberError } = await ctx.admin.rpc('get_payout_destination_account_number', {
    p_destination_id: params.destinationId,
  })
  if (accountNumberError) throw new PayoutDestinationError('internal_consistency_error', accountNumberError.message)

  try {
    const result = await client.createBankAccountVerification({
      accountNumber: accountNumber as string,
      accountType: dest.account_type,
      branchCode: dest.universal_branch_code,
      idNumber: identity.id_reference_number,
      lastName: identity.legal_surname ?? undefined,
    })

    const { error: submittedError } = await ctx.admin.rpc('record_bank_verification_submitted', {
      p_attempt_id: attemptId,
      p_provider_verification_id: result.bankVerificationId,
      p_initial_status: result.status,
      p_result_code: result.resultCode,
    })
    if (submittedError) throw new PayoutDestinationError('internal_consistency_error', submittedError.message)

    return { attemptId, providerVerificationId: result.bankVerificationId, status: result.status }
  } catch (err) {
    if (err instanceof PayoutDestinationError) throw err
    // The attempt is deliberately left at its 'pending' insert-time
    // status on a provider failure (mirrors completeDisputeRefundWithProvider's
    // own "leave it in an honest intermediate state" convention) --
    // never silently retried, visible for reconciliation/admin retry.
    if (err instanceof ProviderTimeoutError) throw new PayoutDestinationError('provider_timeout', err.message)
    if (err instanceof RetryableProviderError) throw new PayoutDestinationError('retryable_provider_error', err.message)
    if (err instanceof TerminalProviderError) throw new PayoutDestinationError('terminal_provider_error', err.message)
    throw new PayoutDestinationError('internal_consistency_error', err instanceof Error ? err.message : String(err))
  }
}

export interface ReconcileBankVerificationResult {
  ok: boolean
  appliedToDestination: boolean
}

/**
 * Query-based reconciliation (phase brief §53) -- for a missed/delayed
 * webhook, manual admin reconciliation, or a stale pending attempt.
 * Never submits a duplicate BANV; only queries Peach's existing result
 * for an already-known provider_verification_id.
 */
export async function reconcileBankVerification(ctx: PayoutDestinationContext, params: { providerVerificationId: string }): Promise<ReconcileBankVerificationResult> {
  const config = loadPeachPayoutsConfig()
  if (!config) throw new PayoutDestinationError('provider_configuration_error', 'Peach Payouts is not configured')
  const client = new PeachPayoutsClient(config)

  const result = await client.getBankAccountVerificationResult(params.providerVerificationId)

  const { data, error } = await ctx.admin.rpc('record_bank_verification_result', {
    p_provider: 'peach',
    p_provider_verification_id: params.providerVerificationId,
    p_status: result.status,
    p_result_code: result.resultCode,
    p_field_results: result.fieldResults,
    p_source: 'query_reconciliation',
  })
  if (error) throw new PayoutDestinationError('internal_consistency_error', error.message)

  const parsed = data as { ok: boolean; applied_to_destination?: boolean; duplicate?: boolean; ignored_out_of_order?: boolean }
  return { ok: parsed.ok, appliedToDestination: Boolean(parsed.applied_to_destination) }
}

/**
 * Applies an already signature-verified BANV webhook payload. Fails
 * closed (returns null, never throws/marks anything) on a payload shape
 * that doesn't match the expected query-result shape -- the caller
 * (the webhook route) must treat a null return as "do not acknowledge
 * as processed", so a retried/corrected delivery can still be handled.
 */
export async function applyBankVerificationWebhookPayload(ctx: PayoutDestinationContext, rawPayload: unknown): Promise<ReconcileBankVerificationResult | null> {
  const parsed = parseBanvResultShape(rawPayload)
  if (!parsed) return null

  const { data, error } = await ctx.admin.rpc('record_bank_verification_result', {
    p_provider: 'peach',
    p_provider_verification_id: parsed.bankVerificationId,
    p_status: parsed.status,
    p_result_code: parsed.resultCode,
    p_field_results: parsed.fieldResults,
    p_source: 'webhook',
  })
  if (error) throw new PayoutDestinationError('internal_consistency_error', error.message)

  const result = data as { ok: boolean; applied_to_destination?: boolean }
  return { ok: result.ok, appliedToDestination: Boolean(result.applied_to_destination) }
}

export interface PayoutDestinationEligibility {
  eligible: boolean
  reason: string | null
  destinationId: string | null
}

/** The one authoritative check a future payout-execution phase must call. */
export async function getPayoutDestinationEligibility(ctx: PayoutDestinationContext, ownerId: string): Promise<PayoutDestinationEligibility> {
  const { data, error } = await ctx.admin.rpc('_payout_destination_eligibility', { p_owner_id: ownerId })
  if (error) throw new PayoutDestinationError('internal_consistency_error', error.message)

  const result = data as { eligible: boolean; reason: string | null; destination_id: string | null }
  return { eligible: result.eligible, reason: result.reason, destinationId: result.destination_id }
}

export async function disablePayoutDestination(
  ctx: PayoutDestinationContext,
  params: { destinationId: string; actorId: string; actorType?: 'owner' | 'admin'; reason?: string }
): Promise<void> {
  const { error } = await ctx.admin.rpc('disable_payout_destination', {
    p_destination_id: params.destinationId,
    p_actor_id: params.actorId,
    p_actor_type: params.actorType ?? 'owner',
    p_reason: params.reason ?? null,
  })
  if (error) throw mapRpcError(error.message, 'destination_not_found')
}

function mapRpcError(message: string | undefined, fallback: PayoutDestinationError['code']): PayoutDestinationError {
  const m = message ?? ''
  if (m.includes('concurrent bank-detail change')) return new PayoutDestinationError('concurrent_change', 'A concurrent bank-detail change is already in progress -- please retry')
  if (m.includes('unknown or inactive bank_code')) return new PayoutDestinationError('bank_not_found', 'Unknown or inactive bank')
  if (m.includes('does not support payouts')) return new PayoutDestinationError('bank_payout_unsupported', 'This bank does not support payouts')
  if (m.includes('does not support bank account verification')) return new PayoutDestinationError('bank_banv_unsupported', 'This bank does not support bank account verification')
  if (m.includes('not found')) return new PayoutDestinationError('destination_not_found', 'Payout destination not found')
  if (m.includes('is not current or is disabled')) return new PayoutDestinationError('destination_not_current', 'This destination is no longer current or has been disabled')
  if (m.includes('account number must be')) return new PayoutDestinationError('invalid_input', 'Account number must be 1-13 numeric characters')
  if (m.includes('invalid account type')) return new PayoutDestinationError('invalid_input', 'Invalid account type')
  return new PayoutDestinationError(fallback, m || 'Unexpected error')
}
