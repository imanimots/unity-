import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidPaymentTransition, type PaymentStatus } from '../state-machine'
import { toMinorUnits } from '../providers/orchestration/amount'
import { categorizeOrchestrationStatus } from '../providers/orchestration/webhook-envelope'
import type { OrchestrationNextAction } from '../providers/orchestration/types'

/**
 * Provider-neutral (in practice Orchestration-only today, but never
 * accepts an HTTP request/headers -- P5D-A's own design requirement)
 * normalized evidence a webhook delivery or a force-sync response has
 * been reduced to, before reconciliation. Both callers (the webhook
 * route and, when wired, a force-sync caller) build one of these; this
 * module never parses a raw payload or reads a header itself.
 */
export interface OrchestrationEvidence {
  providerEventId?: string
  providerEventType?: string
  providerTimestamp?: string
  paymentId: string
  status: string
  amountMinorUnits?: number
  currency?: string
  metadata?: Record<string, unknown>
  nextAction?: OrchestrationNextAction
  source: 'webhook' | 'force_sync'
}

export type ReconciliationOutcome =
  | { outcome: 'transitioned'; paymentId: string; from: PaymentStatus; to: PaymentStatus }
  | { outcome: 'already_current'; paymentId: string; status: PaymentStatus }
  | { outcome: 'pending_noop'; paymentId: string }
  | { outcome: 'stale'; paymentId: string; rawStatus: string }
  | { outcome: 'manual_review'; paymentId: string; reason: string }
  | { outcome: 'unknown_payment' }
  | { outcome: 'ambiguous_provider_reference' }
  | { outcome: 'rejected_mismatch'; paymentId: string; reason: 'amount' | 'currency' }
  | { outcome: 'unknown_status'; paymentId: string; rawStatus: string }

interface PaymentRow {
  id: string
  status: PaymentStatus
  payment_type: string
  amount: string
  currency: string
}

/**
 * The single reconciliation entry point every source (webhook, and once
 * wired, force-sync/return-page/future sweep/future admin reconcile)
 * converges on. Never accepts a Request/NextRequest/raw headers --
 * `evidence` is already fully normalized by the caller.
 *
 * MANUAL-REVIEW AUDIT INTERFACE GAP (documented here, not silently
 * hidden): this function does NOT write a new `payment_events` row for
 * a non-transitioning outcome (manual_review / rejected_mismatch /
 * unknown_status / unknown_payment / ambiguous_provider_reference).
 * No existing RPC inserts a `payment_events` row without performing an
 * actual `transition_payment_status` call (the two existing writers --
 * create_payment_intent and transition_payment_status -- both always
 * pair the insert with a real state change), and this phase authorizes
 * no new migration. The durable record for these outcomes is therefore
 * `payment_webhook_events.payload` (already written by
 * `record_webhook_event` before this function is ever called) plus the
 * safe structured console.error() calls below -- exactly the fallback
 * the P5D-A.1/P5D-B briefs both explicitly sanction ("log safely...
 * do not invent a schema"). A future `record_payment_review_event`-style
 * RPC (mirroring `record_late_payment_reconciliation`'s existing
 * pattern for bookings) would close this gap; not built here.
 */
export async function reconcileOrchestrationPayment(admin: SupabaseClient, evidence: OrchestrationEvidence): Promise<ReconciliationOutcome> {
  // Lookup: content.payment_id -> payments.provider_reference, scoped to
  // the Peach provider identifier, exact match only, never fuzzy. Fetch
  // up to 2 rows so 1-vs->1 can be distinguished without a separate
  // count query (payments.provider_reference has no DB uniqueness
  // constraint yet -- P5D-A.1's own confirmed, separately-gated gap).
  const { data: rows, error: lookupError } = await admin
    .from('payments')
    .select('id, status, payment_type, amount, currency')
    .eq('provider', 'peach')
    .eq('provider_reference', evidence.paymentId)
    .limit(2)

  if (lookupError) {
    // A genuine infrastructure failure, not a business outcome -- the
    // caller (the webhook route) must treat this as transient and call
    // mark_webhook_event_error(), never silently swallow it into a
    // handled outcome.
    throw lookupError
  }

  if (!rows || rows.length === 0) {
    safeLog('unknown_payment', { providerPaymentId: evidence.paymentId, source: evidence.source })
    return { outcome: 'unknown_payment' }
  }
  if (rows.length > 1) {
    // Cannot safely attach a review record to one row -- see this
    // function's own doc comment. Never choose the first row
    // arbitrarily.
    safeLog('ambiguous_provider_reference', { providerPaymentId: evidence.paymentId, matchCount: rows.length, source: evidence.source })
    return { outcome: 'ambiguous_provider_reference' }
  }

  const payment = rows[0] as PaymentRow

  // Metadata cross-check: supporting evidence only, never a redirect
  // target. A disagreement is itself the finding -- no transition.
  const metadataUnityPaymentId = evidence.metadata?.unity_payment_id
  if (typeof metadataUnityPaymentId === 'string' && metadataUnityPaymentId.length > 0 && metadataUnityPaymentId !== payment.id) {
    safeLog('webhook_reference_mismatch', { paymentId: payment.id, metadataUnityPaymentId, source: evidence.source })
    return { outcome: 'manual_review', paymentId: payment.id, reason: 'metadata unity_payment_id does not match the provider_reference-resolved payment row' }
  }

  const category = categorizeOrchestrationStatus(evidence.status)

  if (category.kind === 'unknown') {
    safeLog('webhook_unknown_status', { paymentId: payment.id, rawStatus: category.rawStatus, source: evidence.source })
    return { outcome: 'unknown_status', paymentId: payment.id, rawStatus: category.rawStatus }
  }

  if (category.kind === 'no_transition') {
    // requires_payment_method / requires_confirmation / requires_action
    // / requires_customer_action / processing -- pending is the only
    // sensible current status for a genuine, in-order "still working on
    // it" signal. Anything else means the payment already moved past
    // pending and this signal arrived late/out of order -- stale, not
    // an error, but never regresses the newer state.
    if (payment.status === 'pending') {
      return { outcome: 'pending_noop', paymentId: payment.id }
    }
    safeLog('webhook_stale_event', { paymentId: payment.id, rawStatus: evidence.status, currentStatus: payment.status, source: evidence.source })
    return { outcome: 'stale', paymentId: payment.id, rawStatus: evidence.status }
  }

  const target: PaymentStatus =
    category.kind === 'cancelled'
      ? payment.status === 'authorised'
        ? 'released'
        : 'cancelled'
      : category.target

  if (target === payment.status) {
    return { outcome: 'already_current', paymentId: payment.id, status: payment.status }
  }

  if (!isValidPaymentTransition(payment.status, target)) {
    safeLog('webhook_invalid_transition', { paymentId: payment.id, from: payment.status, to: target, rawStatus: evidence.status, source: evidence.source })
    return { outcome: 'manual_review', paymentId: payment.id, reason: `provider status "${evidence.status}" implies ${payment.status} -> ${target}, not a valid transition` }
  }

  // A genuine state-advancing transition is about to happen -- amount
  // and currency must both be present and exactly correct first. Never
  // guess a missing value; a mismatch or absence is itself the finding.
  if (evidence.amountMinorUnits === undefined) {
    safeLog('webhook_amount_mismatch', { paymentId: payment.id, reason: 'missing provider amount', source: evidence.source })
    return { outcome: 'rejected_mismatch', paymentId: payment.id, reason: 'amount' }
  }
  const expectedMinorUnits = toMinorUnits(payment.amount)
  if (evidence.amountMinorUnits !== expectedMinorUnits) {
    safeLog('webhook_amount_mismatch', { paymentId: payment.id, expectedMinorUnits, receivedMinorUnits: evidence.amountMinorUnits, source: evidence.source })
    return { outcome: 'rejected_mismatch', paymentId: payment.id, reason: 'amount' }
  }

  if (!evidence.currency) {
    safeLog('webhook_currency_mismatch', { paymentId: payment.id, reason: 'missing provider currency', source: evidence.source })
    return { outcome: 'rejected_mismatch', paymentId: payment.id, reason: 'currency' }
  }
  if (evidence.currency.toUpperCase() !== payment.currency.toUpperCase()) {
    safeLog('webhook_currency_mismatch', { paymentId: payment.id, expected: payment.currency, received: evidence.currency, source: evidence.source })
    return { outcome: 'rejected_mismatch', paymentId: payment.id, reason: 'currency' }
  }

  // Deterministic idempotency key -- never random. Webhook: stable per
  // delivery's own event_id (a retry of the same delivery reuses the
  // same key). Force-sync: stable per (payment, target status) so
  // repeated force-syncs observing the same evidence never create a new
  // logical transition on every page refresh.
  const idempotencyKey =
    evidence.source === 'webhook' && evidence.providerEventId
      ? `webhook:${evidence.providerEventId}`
      : `force_sync:${payment.id}:${target}`

  const { error: transitionError } = await admin.rpc('transition_payment_status', {
    p_payment_id: payment.id,
    p_new_status: target,
    p_provider_reference: evidence.paymentId,
    p_actor_type: 'webhook',
    p_idempotency_key: idempotencyKey,
  })

  if (transitionError) {
    throw transitionError
  }

  return { outcome: 'transitioned', paymentId: payment.id, from: payment.status, to: target }
}

/**
 * Safe structured logging only -- never a secret, never a raw provider
 * payload, never an unbounded value. See this file's own doc comment
 * for why this substitutes for a durable payment_events row this phase.
 */
function safeLog(reason: string, fields: Record<string, unknown>): void {
  console.error(`[orchestration.reconcile] ${reason}`, fields)
}
