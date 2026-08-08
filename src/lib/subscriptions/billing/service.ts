import type { SupabaseClient } from '@supabase/supabase-js'
import { getSubscriptionBillingProvider } from './registry'
import type { SubscriptionMockScenario } from './provider'

export interface AttemptSubscriptionBillingInput {
  merchantId: string
  planId: string
  amountCents: number
  currency?: string
  idempotencyKey?: string
  mockScenario?: SubscriptionMockScenario
}

export interface AttemptSubscriptionBillingResult {
  success: boolean
  providerReference: string | null
  billingAttemptId: string
  failureReason?: string
}

/**
 * The one call site every upgrade route uses to obtain a billing
 * reference before calling request_merchant_plan_change() -- never calls
 * the provider directly. Records one row in
 * merchant_subscription_billing_attempts per attempt (an append-only
 * audit trail, not itself an idempotency mechanism) and, when an
 * idempotencyKey is supplied, replays a prior attempt's own recorded
 * result instead of charging a second time -- mirrors the
 * check-then-insert shape every RPC-level idempotency check in this
 * codebase already uses, just expressed in TS since this table has no
 * dedicated insert RPC (it is only ever written by trusted server-side
 * billing code, never reachable from a client -- RLS on the table
 * permits zero client writes regardless).
 */
export async function attemptSubscriptionBilling(
  admin: SupabaseClient,
  input: AttemptSubscriptionBillingInput
): Promise<AttemptSubscriptionBillingResult> {
  const currency = input.currency ?? 'ZAR'

  if (input.idempotencyKey) {
    const { data: existing } = await admin
      .from('merchant_subscription_billing_attempts')
      .select('id, status, provider_reference, failure_reason')
      .eq('merchant_id', input.merchantId)
      .eq('idempotency_key', input.idempotencyKey)
      .maybeSingle()

    if (existing) {
      return {
        success: existing.status === 'succeeded',
        providerReference: existing.provider_reference,
        billingAttemptId: existing.id,
        failureReason: existing.failure_reason ?? undefined,
      }
    }
  }

  const provider = getSubscriptionBillingProvider()
  const chargeResult = await provider.chargePlan({
    merchantId: input.merchantId,
    planId: input.planId,
    amountCents: input.amountCents,
    currency,
    mockScenario: input.mockScenario,
  })

  const { data: inserted, error } = await admin
    .from('merchant_subscription_billing_attempts')
    .insert({
      merchant_id: input.merchantId,
      plan_id: input.planId,
      amount_cents: input.amountCents,
      currency,
      provider: provider.name,
      provider_reference: chargeResult.providerReference,
      status: chargeResult.status,
      failure_reason: chargeResult.failureReason ?? null,
      mock_scenario: input.mockScenario ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select('id')
    .single()

  if (error || !inserted) {
    throw error ?? new Error('failed to record subscription billing attempt')
  }

  return {
    success: chargeResult.status === 'succeeded',
    providerReference: chargeResult.providerReference,
    billingAttemptId: inserted.id,
    failureReason: chargeResult.failureReason,
  }
}
