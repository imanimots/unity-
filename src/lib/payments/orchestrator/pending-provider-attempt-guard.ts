import type { OrchestratorContext } from './types'
import { OrchestrationError } from './errors'

/**
 * P5C.1 safety guard: prevents a retry from creating a SECOND live
 * Hosted Checkout session while an earlier attempt's session is still
 * open (i.e. the most recent `payment_attempts` row for this payment
 * recorded `status = 'pending'`, the value written when a provider
 * returns `requires_action`).
 *
 * This is a deliberately narrow, explicit check -- not a general
 * idempotency-cache mechanism (several callers already have their own
 * idempotency-key-based replay cache for that, which independently
 * covers the exact-same-request-replayed case). This guard covers the
 * different case: a caller retries the *same operation* without
 * supplying (or with a *different*) idempotency key while a prior
 * attempt's Hosted Checkout session genuinely has not resolved yet.
 * Without it, every retry would call the provider again, abandoning the
 * previous session and creating a new one -- wasteful, and the kind of
 * "repeated live payment session" this phase's own scope explicitly
 * prohibits creating.
 *
 * Never blocks a payment that has already reached a terminal state
 * (`captured`/`authorised`/`failed`/etc.) -- every caller already
 * short-circuits on those via its own existing `payment.status` guard,
 * before this function is ever reached.
 */
export async function assertNoPendingProviderAttempt(admin: OrchestratorContext['admin'], paymentId: string): Promise<void> {
  const { data: latestAttempt } = await admin
    .from('payment_attempts')
    .select('status')
    .eq('payment_id', paymentId)
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestAttempt?.status === 'pending') {
    throw new OrchestrationError(
      'duplicate_workflow_conflict',
      'A payment session is already in progress for this payment -- please complete the existing checkout, or wait for it to resolve, before retrying'
    )
  }
}
