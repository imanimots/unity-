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

/**
 * `paymentType`/`bookingId`/`orderId`/`rentToBuyAgreementId`/`renterId`/
 * `metadata` are only carried on the two outcomes that can represent a
 * genuine financial completion (`transitioned` and `already_current`) --
 * exactly what completeAsyncPaymentBusinessProgression() needs to
 * dispatch domain progression without a second lookup, and nothing
 * else. `bookingId`/`orderId`/`rentToBuyAgreementId` are `null` when the
 * payment belongs to a different domain (payments.booking_id/order_id/
 * rent_to_buy_agreement_id are mutually-exclusive-with-the-other-domain-
 * FKs nullable columns -- confirmed via
 * 20260812000002_order_payments_widening.sql's own
 * payments_one_transaction_chk). `renterId` carries payments.renter_id --
 * for an RTB installment/payoff/deposit payment this is always the
 * agreement's own customer_id (create_rent_to_buy_payment_intent inserts
 * it directly from p_payer_id, and every RTB caller passes
 * agreement.customer_id as p_payer_id -- confirmed by direct source
 * reading, not assumed), which is exactly the persisted, authoritative
 * actor identity payoff_rent_to_buy_agreement's own p_actor_user_id
 * check requires (P5D-B.2 S14).
 */
export type ReconciliationOutcome =
  | {
      outcome: 'transitioned'
      paymentId: string
      from: PaymentStatus
      to: PaymentStatus
      paymentType: string
      bookingId: string | null
      orderId: string | null
      rentToBuyAgreementId: string | null
      renterId: string | null
      metadata: Record<string, unknown>
    }
  | {
      outcome: 'already_current'
      paymentId: string
      status: PaymentStatus
      paymentType: string
      bookingId: string | null
      orderId: string | null
      rentToBuyAgreementId: string | null
      renterId: string | null
      metadata: Record<string, unknown>
    }
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
  booking_id: string | null
  order_id: string | null
  rent_to_buy_agreement_id: string | null
  renter_id: string | null
  metadata: Record<string, unknown> | null
}

/**
 * The exact, complete `payment_type` Postgres enum values that use
 * manual-capture/pre-authorisation semantics (`provider.authorizeDeposit()`,
 * `capture_method: 'manual'`) -- confirmed P5D-B.1 by reading every enum
 * widening migration and every orchestrator call site that constructs a
 * payment intent, not assumed from naming: the base enum
 * (20260801000001_payment_enums.sql) only ever had 'deposit' /
 * 'rental_charge', but later migrations widened it with
 * 'order_payment' (20260812000001), 'barter_deposit' /
 * 'barter_cash_adjustment' (20260816000001), and
 * 'rent_to_buy_installment' / 'rent_to_buy_deposit' (20260827000001).
 *
 * P5D-B.2: 'rent_to_buy_deposit' moved OUT of this set -- its economic
 * intent is immediate collection (confirmed against docs/RENT_TO_BUY.md
 * and Peach documentation, P5D-B.2-D), and charge-rent-to-buy-deposit.ts
 * now uses chargeRental() (automatic capture), the same operation every
 * other member of the immediate-settlement family already uses. Of the
 * seven payment_type values, exactly two remain genuinely manual-capture:
 *   - 'deposit'            -- authorize-booking-financials.ts
 *   - 'barter_deposit'     -- authorize-barter-deposit.ts
 * The other five ('rental_charge', 'order_payment',
 * 'barter_cash_adjustment', 'rent_to_buy_installment',
 * 'rent_to_buy_deposit') all use `chargeRental()` (automatic capture) --
 * confirmed by direct source reading of every orchestrator call site,
 * not inferred from a type name containing "deposit".
 */
const MANUAL_CAPTURE_PAYMENT_TYPES = new Set(['deposit', 'barter_deposit'])

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
    .select('id, status, payment_type, amount, currency, booking_id, order_id, rent_to_buy_agreement_id, renter_id, metadata')
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

  // P5D-B.1: every remaining branch (category.kind is 'target' or
  // 'cancelled') must resolve its target with awareness of
  // payment.payment_type -- a P5D-B-R review found the original version
  // mapped requires_capture -> authorised and cancelled -> released
  // purely from current status, with no check that the payment is
  // actually one of the three manual-capture types. An automatic-capture
  // payment (rental_charge/order_payment/barter_cash_adjustment/
  // rent_to_buy_installment) receiving provider evidence that only makes
  // sense for a manual-capture flow is never guessed into a transition.
  const isManualCaptureType = MANUAL_CAPTURE_PAYMENT_TYPES.has(payment.payment_type)

  if (category.kind === 'target' && category.target === 'authorised') {
    // requires_capture
    if (!isManualCaptureType) {
      safeLog('webhook_invalid_provider_state', {
        paymentId: payment.id,
        reason: 'requires_capture on a non-manual-capture payment_type',
        paymentType: payment.payment_type,
        source: evidence.source,
      })
      return {
        outcome: 'manual_review',
        paymentId: payment.id,
        reason: `provider status "requires_capture" is not valid for payment_type "${payment.payment_type}" -- only deposit/barter_deposit/rent_to_buy_deposit payments support manual capture`,
      }
    }
  }

  if (category.kind === 'target' && category.target === 'captured' && isManualCaptureType && payment.status === 'authorised') {
    // succeeded, on an authorised manual-capture payment: P5D-B.1 audit
    // (capture-deposit.ts) confirmed deposit capture is a deliberate,
    // reasoned, admin/dispute-gated action via the dedicated
    // capture_deposit_amount RPC (required p_reason, required p_amount,
    // booking-status eligibility check) -- not something a generic
    // webhook 'succeeded' signal can safely trigger. The same
    // conservative default applies to barter_deposit/rent_to_buy_deposit:
    // auto-capturing via the generic transition_payment_status path
    // would bypass whatever domain-specific recording each of those
    // flows' own dedicated capture path is responsible for.
    safeLog('webhook_invalid_provider_state', {
      paymentId: payment.id,
      reason: 'succeeded on an authorised manual-capture payment requires the dedicated capture workflow, not a generic webhook transition',
      paymentType: payment.payment_type,
      source: evidence.source,
    })
    return {
      outcome: 'manual_review',
      paymentId: payment.id,
      reason: 'an authorised manual-capture payment reaching "succeeded" must be captured via its own dedicated, reasoned capture workflow, never a generic webhook transition',
    }
  }

  if (category.kind === 'cancelled' && payment.status === 'authorised' && !isManualCaptureType) {
    // A non-manual-capture payment should never legitimately be
    // 'authorised' in the first place (only the requires_capture guard
    // above, now closed, could have put it there) -- if one is found in
    // that state anyway, never guess whether 'cancelled' means
    // 'released' (a deposit-specific term) is safe to apply here.
    safeLog('webhook_invalid_provider_state', {
      paymentId: payment.id,
      reason: 'authorised non-manual-capture payment received cancelled -- payment_type inconsistent with its own status',
      paymentType: payment.payment_type,
      source: evidence.source,
    })
    return {
      outcome: 'manual_review',
      paymentId: payment.id,
      reason: `payment is "authorised" but payment_type "${payment.payment_type}" does not support manual capture -- cannot safely label a cancelled event as released`,
    }
  }

  if (category.kind === 'target' && category.target === 'partially_captured' && !isManualCaptureType) {
    // partially_captured only makes semantic sense for a manual-capture
    // flow (an ordinary automatic-capture charge is always full-amount);
    // isValidPaymentTransition already makes this unreachable from
    // 'pending' for any type, but this guard makes the business-context
    // requirement explicit rather than relying solely on that side effect.
    safeLog('webhook_invalid_provider_state', {
      paymentId: payment.id,
      reason: 'partially_captured on a non-manual-capture payment_type',
      paymentType: payment.payment_type,
      source: evidence.source,
    })
    return {
      outcome: 'manual_review',
      paymentId: payment.id,
      reason: `provider status "partially_captured" is not valid for payment_type "${payment.payment_type}"`,
    }
  }

  const target: PaymentStatus =
    category.kind === 'cancelled'
      ? payment.status === 'authorised'
        ? 'released'
        : 'cancelled'
      : category.target

  if (target === payment.status) {
    return {
      outcome: 'already_current',
      paymentId: payment.id,
      status: payment.status,
      paymentType: payment.payment_type,
      bookingId: payment.booking_id,
      orderId: payment.order_id,
      rentToBuyAgreementId: payment.rent_to_buy_agreement_id,
      renterId: payment.renter_id,
      metadata: payment.metadata ?? {},
    }
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

  return {
    outcome: 'transitioned',
    paymentId: payment.id,
    from: payment.status,
    to: target,
    paymentType: payment.payment_type,
    bookingId: payment.booking_id,
    orderId: payment.order_id,
    rentToBuyAgreementId: payment.rent_to_buy_agreement_id,
    renterId: payment.renter_id,
    metadata: payment.metadata ?? {},
  }
}

/**
 * Safe structured logging only -- never a secret, never a raw provider
 * payload, never an unbounded value. See this file's own doc comment
 * for why this substitutes for a durable payment_events row this phase.
 */
function safeLog(reason: string, fields: Record<string, unknown>): void {
  console.error(`[orchestration.reconcile] ${reason}`, fields)
}

export type BusinessProgressionOutcome = { outcome: 'not_applicable' } | { outcome: 'completed' } | { outcome: 'manual_review'; reason: string }

/**
 * P5D-B.1: `payments.status` changing is not the same as the business
 * object reaching the state the SYNCHRONOUS checkout path would have
 * produced -- a P5D-B-R review found the async webhook path never
 * triggered any of the domain-specific follow-up each synchronous
 * charge orchestrator already performs after a successful provider
 * call (bookings: checkAndRecordLateSuccessIfExpired; orders:
 * mark_order_paid; RTB: record_rent_to_buy_installment_payment /
 * record_rent_to_buy_deposit_payment). This function is the narrow,
 * domain-aware dispatcher the webhook route calls right after
 * reconcileOrchestrationPayment() -- kept separate from it so financial
 * reconciliation and business-state dispatch stay two distinct
 * concerns, per this phase's own "keep the route thin, don't reimplement
 * domain SQL here" instruction.
 *
 * CRASH-RECOVERY DESIGN (P5D-B.1 §13/§14): runs for BOTH `transitioned`
 * (a fresh transition just happened) and `already_current` (the payment
 * already reached the same target on a PRIOR attempt that may have
 * crashed before this exact progression step ran) -- an `already_current`
 * outcome is only ever produced when target === the payment's actual
 * current status (see reconcileOrchestrationPayment's own construction
 * of it), so it is always the "legitimate equivalent-target" case, never
 * stale/inconsistent evidence being used as blanket permission to
 * advance business state. Every domain primitive called here is
 * independently confirmed idempotent (see each branch's own comment),
 * so re-running this function on a retry after a genuine failure is
 * always safe. The caller (the webhook route) is responsible for NOT
 * marking the webhook event processed if this function throws -- a
 * thrown error here must surface as a transient failure so a retry can
 * complete the still-missing progression, never silently leaving the
 * business object stuck while the event is marked handled.
 *
 * SCOPE, EXPLICITLY NOT WIRED THIS PHASE (reported, not silently
 * omitted -- see the P5D-B.2 phase report):
 *   - RTB deposit progression (record_rent_to_buy_deposit_payment) --
 *     re-read fresh at P5D-B.2 and found to have NO idempotency guard at
 *     all (no idempotency-key check, no "already recorded" short-circuit
 *     -- every call unconditionally inserts a new rent_to_buy_history
 *     row). Safe for the synchronous path (called at most once per
 *     successful charge, guarded by charge-rent-to-buy-deposit.ts's own
 *     "already captured -> return early" check before ever re-entering
 *     the charge step), but NOT safe to wire into this function, which
 *     is deliberately re-run on every `already_current` recovery --
 *     exactly the repeated-invocation pattern this RPC has no protection
 *     against. Wiring it here would produce a duplicate history row on
 *     every retried webhook/force-sync poll for an already-captured
 *     deposit. Genuinely blocked without a narrow RPC-hardening
 *     migration (out of this phase's scope) -- not routed around.
 *   - Barter requires no domain-specific progression at all beyond the
 *     payment transition itself -- confirmed: authorize-barter-deposit.ts
 *     and charge-barter-cash-adjustment.ts call only
 *     record_payment_attempt/transition_payment_status, no
 *     domain-specific RPC exists for either barter payment_type.
 *   - Escrow funding remains out of scope here, unchanged from P5D-B.1 --
 *     already documented as "best-effort, never blocks" in every
 *     synchronous caller, and P5D-B.2 was explicitly directed not to
 *     enlarge escrow's footprint.
 *
 * RTB INSTALLMENT/PAYOFF (P5D-B.2, wired this phase): dispatches on
 * payments.metadata, written once and immutably by
 * create_rent_to_buy_payment_intent (P5D-M2/P5D-M3) -- never guessed,
 * never inferred from "whatever is currently unpaid":
 *   - metadata.rent_to_buy_installment_sequence present -> ordinary
 *     single-installment completion via
 *     record_rent_to_buy_installment_payment (idempotent: an already-
 *     'paid' installment returns already_paid=true, confirmed by direct
 *     source reading, 20260827000005_rtb_rpcs.sql).
 *   - metadata.rent_to_buy_payoff_sequences present -> payoff completion
 *     via payoff_rent_to_buy_agreement (P5D-M3), using payments.renter_id
 *     as the persisted, proven-authoritative actor identity (see this
 *     file's own ReconciliationOutcome doc comment) -- never an
 *     interactive request user, since none exists on this path. A
 *     completed/already_completed result is success; a payment_conflict/
 *     invalid_snapshot result is a PERMANENT business-state conflict
 *     (the P5D-M3 RPC itself guarantees no write occurred) -- logged via
 *     safeLog() and returned as `manual_review`, never thrown. Retrying
 *     forever cannot resolve a permanent conflict, so this deliberately
 *     does NOT block mark_webhook_event_processed, exactly mirroring how
 *     reconcileOrchestrationPayment's own pre-existing manual_review
 *     outcomes are already handled (see this file's own doc comment on
 *     the "manual-review audit interface gap").
 *   - Neither key present -> a legacy payment predating this
 *     correlation mechanism (or one created by application code from
 *     before this phase). NO GUESSING: never chooses the lowest-unpaid
 *     or next-scheduled installment, never parses a sequence from the
 *     idempotency key, never infers from provider metadata. Logged via
 *     safeLog() and returned as `manual_review` -- the same durable,
 *     already-established fallback (safeLog + the payment_webhook_events
 *     audit row already written before reconciliation ever runs), since
 *     no other "flag for review" primitive exists in this codebase
 *     without a new migration (out of scope this phase).
 *
 * COMMISSION QUALIFICATION (P5D-B.2, wired this phase): unlike the
 * existing qualifySaleAffiliateCommission()/qualifySaleUnityCommission()/
 * qualifyRentalPaymentAffiliateCommission()/
 * qualifyRentalPaymentUnityCommission() wrappers (src/lib/affiliate/
 * qualify.ts, src/lib/commissions/qualify.ts) -- which are deliberately
 * best-effort/never-throw for their EXISTING synchronous call sites,
 * where a commission bug must never roll back the customer's actual
 * payment -- this function calls the underlying
 * qualify_sale_affiliate_commission / qualify_sale_unity_commission /
 * qualify_rental_payment_affiliate_commission /
 * qualify_rental_payment_unity_commission RPCs directly and lets a
 * genuine RPC error PROPAGATE (`if (error) throw error`, exactly like
 * mark_order_paid below). This is a deliberate, narrow difference in
 * error-propagation for this ONE additional call site, not a change to
 * the wrapper functions or their existing callers: commission
 * entitlement is mandatory business progression on the async path (no
 * missing-commission sweep exists anywhere in this codebase to recover a
 * silently-swallowed failure), so a transient failure here must prevent
 * mark_webhook_event_processed exactly like a booking/order/RTB
 * progression failure already does. Idempotency key construction
 * (computeQualifyCommissionHash) and the RPCs themselves are reused
 * unmodified -- both re-confirmed idempotent-by-payment_id fresh this
 * phase (unique(payment_id) + an explicit already-qualified pre-check,
 * 20260823000007_unity_commission_qualify_idempotency_fk_fix.sql /
 * 20260904000025_affiliate_current_plan_gate_for_new_activity.sql) -- no
 * calculation logic is duplicated, only the call site's throw behavior
 * differs from the existing wrappers'.
 */
export async function completeAsyncPaymentBusinessProgression(admin: SupabaseClient, reconciliation: ReconciliationOutcome): Promise<BusinessProgressionOutcome> {
  if (reconciliation.outcome !== 'transitioned' && reconciliation.outcome !== 'already_current') {
    return { outcome: 'not_applicable' }
  }

  const achievedStatus = reconciliation.outcome === 'transitioned' ? reconciliation.to : reconciliation.status
  // Only a genuine "money captured" or "hold placed" completion ever
  // triggers domain progression -- never failed/cancelled/released/
  // refunded/etc.
  if (achievedStatus !== 'captured' && achievedStatus !== 'authorised') {
    return { outcome: 'not_applicable' }
  }

  if (reconciliation.bookingId) {
    // Idempotent (confirmed, unchanged from the synchronous path's own
    // use): "at most one such marker per booking" -- reused verbatim,
    // not reimplemented. Runs for either the rental leg (captured) or
    // the deposit leg (authorised) reaching its target, matching the
    // synchronous path's own booking-level (not leg-specific) check.
    const { checkAndRecordLateSuccessIfExpired } = await import('@/lib/bookings/late-payment-reconciliation')
    await checkAndRecordLateSuccessIfExpired(admin, reconciliation.bookingId)
  }

  if (reconciliation.orderId && reconciliation.paymentType === 'order_payment' && achievedStatus === 'captured') {
    // Confirmed idempotent by direct source reading
    // (20260812000005_order_idempotency_fk_fix.sql): "if v_order.status
    // = 'paid' then ... naturally idempotent, not an error ... return"
    // -- safe to call again on a retry regardless of idempotency key.
    const { error } = await admin.rpc('mark_order_paid', {
      p_order_id: reconciliation.orderId,
      p_payment_id: reconciliation.paymentId,
      p_idempotency_key: `async-reconcile:${reconciliation.paymentId}`,
    })
    if (error) throw error
  }

  if (reconciliation.paymentType === 'rent_to_buy_installment' && achievedStatus === 'captured' && reconciliation.rentToBuyAgreementId) {
    const metadata = reconciliation.metadata
    const sequence = metadata.rent_to_buy_installment_sequence
    const payoffSequences = metadata.rent_to_buy_payoff_sequences

    if (typeof sequence === 'number' && Number.isInteger(sequence) && sequence > 0) {
      const { error } = await admin.rpc('record_rent_to_buy_installment_payment', {
        p_agreement_id: reconciliation.rentToBuyAgreementId,
        p_sequence: sequence,
        p_payment_id: reconciliation.paymentId,
        p_idempotency_key: `async-reconcile:${reconciliation.paymentId}`,
      })
      if (error) throw error
    } else if (Array.isArray(payoffSequences) && payoffSequences.length > 0) {
      if (!reconciliation.renterId) {
        safeLog('rtb_payoff_missing_actor', { paymentId: reconciliation.paymentId, rentToBuyAgreementId: reconciliation.rentToBuyAgreementId })
        return { outcome: 'manual_review', reason: 'rent-to-buy payoff payment has no persisted renter_id to use as the async actor identity' }
      }
      const { data, error } = await admin.rpc('payoff_rent_to_buy_agreement', {
        p_actor_user_id: reconciliation.renterId,
        p_agreement_id: reconciliation.rentToBuyAgreementId,
        p_payment_id: reconciliation.paymentId,
      })
      if (error) throw error
      const status = (data as { status?: string } | null)?.status
      if (status !== 'completed' && status !== 'already_completed') {
        // Permanent business-state conflict (payment_conflict/
        // invalid_snapshot) -- the RPC itself guarantees no installment/
        // ownership write occurred. Never retried forever: a conflict
        // between two captured payments for overlapping installments
        // cannot be resolved by trying again.
        safeLog('rtb_payoff_manual_review', { paymentId: reconciliation.paymentId, rentToBuyAgreementId: reconciliation.rentToBuyAgreementId, result: data })
        return { outcome: 'manual_review', reason: `payoff_rent_to_buy_agreement returned "${status}" -- not a safe automatic completion` }
      }
    } else {
      // Legacy payment predating durable installment/payoff correlation
      // -- no domain guessing.
      safeLog('rtb_installment_uncorrelated_legacy_payment', { paymentId: reconciliation.paymentId, rentToBuyAgreementId: reconciliation.rentToBuyAgreementId })
      return { outcome: 'manual_review', reason: 'rent-to-buy installment payment has no durable installment_sequence or payoff_sequences correlation' }
    }
  }

  if (reconciliation.paymentType === 'rental_charge' && achievedStatus === 'captured' && reconciliation.bookingId) {
    const { computeQualifyCommissionHash: computeAffiliateHash } = await import('@/lib/affiliate/idempotency')
    const { error: affiliateError } = await admin.rpc('qualify_rental_payment_affiliate_commission', {
      p_booking_id: reconciliation.bookingId,
      p_payment_id: reconciliation.paymentId,
      p_idempotency_key: computeAffiliateHash(reconciliation.bookingId, reconciliation.paymentId),
    })
    if (affiliateError) throw affiliateError

    const { computeQualifyCommissionHash: computeUnityHash } = await import('@/lib/commissions/idempotency')
    const { error: unityError } = await admin.rpc('qualify_rental_payment_unity_commission', {
      p_booking_id: reconciliation.bookingId,
      p_payment_id: reconciliation.paymentId,
      p_idempotency_key: computeUnityHash(reconciliation.bookingId, reconciliation.paymentId),
    })
    if (unityError) throw unityError
  }

  if (reconciliation.paymentType === 'order_payment' && achievedStatus === 'captured' && reconciliation.orderId) {
    const { computeQualifyCommissionHash: computeAffiliateHash } = await import('@/lib/affiliate/idempotency')
    const { error: affiliateError } = await admin.rpc('qualify_sale_affiliate_commission', {
      p_order_id: reconciliation.orderId,
      p_payment_id: reconciliation.paymentId,
      p_idempotency_key: computeAffiliateHash(reconciliation.orderId, reconciliation.paymentId),
    })
    if (affiliateError) throw affiliateError

    const { computeQualifyCommissionHash: computeUnityHash } = await import('@/lib/commissions/idempotency')
    const { error: unityError } = await admin.rpc('qualify_sale_unity_commission', {
      p_order_id: reconciliation.orderId,
      p_payment_id: reconciliation.paymentId,
      p_idempotency_key: computeUnityHash(reconciliation.orderId, reconciliation.paymentId),
    })
    if (unityError) throw unityError
  }

  return { outcome: 'completed' }
}
