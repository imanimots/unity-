import type { OrchestratorContext, AuthorizeBookingFinancialsResult } from './types'
import { OrchestrationError, type OrchestrationErrorCode } from './errors'
import { prepareBookingFinancials } from './prepare-booking-financials'
import { ProviderTimeoutError, RetryableProviderError, TerminalProviderError } from '../provider-errors'
import { getPaymentProvider } from '../registry'
import type { MockScenario } from '../provider'
import { qualifyRentalPaymentAffiliateCommission } from '@/lib/affiliate/qualify'
import { qualifyRentalPaymentUnityCommission } from '@/lib/commissions/qualify'
import { createEscrowForPayment, fundEscrowForPayment } from '@/lib/escrow/orchestrator'
import { assertNoPendingProviderAttempt } from './pending-provider-attempt-guard'

interface StepOutcome {
  status: string
  redirectUrl?: string
}

/**
 * The one genuinely multi-step workflow in this pass: it makes up to two
 * separate provider calls (rental charge, then deposit authorization) and
 * must be resumable at whichever one failed without repeating the one
 * that already succeeded. See docs/FINANCIAL_ORCHESTRATION.md "Partial
 * failure handling" for the full walkthrough (Scenario B).
 *
 * Resumability comes from two places working together:
 *   1. financial_workflows (one row per booking_id + workflow_type) --
 *      current_step/status/retry_count persist across invocations.
 *   2. each payment's own status -- before calling the provider for a
 *      step, this checks whether that payment already reached its
 *      target status and skips the provider call entirely if so. Even
 *      without the workflow row, re-deriving "what's left to do" from
 *      `payments` alone would be safe; the workflow row adds the single
 *      overall status/observability the task asks for.
 *
 * A call with a matching idempotency key against an already-'completed'
 * workflow returns the cached result immediately -- no provider call, no
 * RPC beyond the initial lookup.
 */
export async function authorizeBookingFinancials(
  ctx: OrchestratorContext,
  bookingId: string,
  idempotencyKey?: string
): Promise<AuthorizeBookingFinancialsResult> {
  const { admin } = ctx
  const providerName = ctx.providerName || process.env.PAYMENT_PROVIDER || 'mock'
  const provider = getPaymentProvider(providerName)

  const { data: started, error: startError } = await admin.rpc('start_or_resume_financial_workflow', {
    p_booking_id: bookingId,
    p_workflow_type: 'authorize_booking_financials',
    p_provider: providerName,
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (startError) {
    if (startError.message.includes('failed terminally')) {
      throw new OrchestrationError('duplicate_workflow_conflict', 'This booking\'s financial authorization has already failed terminally and cannot be resumed automatically.')
    }
    throw new OrchestrationError('internal_consistency_error', `Could not start financial workflow: ${startError.message}`)
  }

  const workflowId: string = started.workflow_id
  if (started.status === 'completed') {
    const cached = started.result as AuthorizeBookingFinancialsResult
    // Step 11 Phase 7: this is a THIRD hook point, earlier than the two
    // inside ensureRentalCharged() below -- a workflow that already
    // reached 'completed' on a prior call short-circuits here and never
    // reaches ensureRentalCharged() at all on any later replay. Without
    // this call, qualification would only ever fire once, on whichever
    // single invocation happened to be the one that actually captured the
    // payment -- silently skipped on every legitimate later replay (e.g.
    // a retried checkout request). Best-effort, never throws.
    if (cached.rentalPaymentId) {
      await qualifyRentalPaymentAffiliateCommission(admin, bookingId, cached.rentalPaymentId)
      await qualifyRentalPaymentUnityCommission(admin, bookingId, cached.rentalPaymentId)
    }
    return cached
  }

  const { rentalPaymentId, depositPaymentId } = await prepareBookingFinancials(ctx, bookingId, idempotencyKey)

  try {
    const rental = await ensureRentalCharged(admin, provider, workflowId, bookingId, rentalPaymentId, ctx.testRentalScenario)
    const deposit = depositPaymentId
      ? await ensureDepositAuthorised(admin, provider, workflowId, depositPaymentId, ctx.testDepositScenario)
      : null

    // P5C.1: if either leg created a Hosted Checkout session the shopper
    // still needs to complete, the overall workflow is NOT 'completed' --
    // it stays 'requires_action', payments.status stays 'pending' for
    // that leg (already true -- neither ensureRentalCharged() nor
    // ensureDepositAuthorised() touches payments.status for this
    // outcome), and this result is NOT cached as the workflow's
    // 'completed' result (a future replay must be allowed to re-check
    // progress, not short-circuit on a stale in-progress snapshot).
    // update_financial_workflow_progress was already called with
    // p_status:'processing' inside whichever step(s) ran -- no further
    // workflow-status write happens here for this branch; the
    // per-payment pending-attempt guard (assertNoPendingProviderAttempt)
    // is what actually prevents a duplicate session on retry.
    if (rental.status === 'requires_action' || deposit?.status === 'requires_action') {
      return {
        workflowId,
        status: 'requires_action',
        rentalPaymentId,
        rentalStatus: rental.status,
        depositPaymentId,
        depositStatus: deposit?.status ?? null,
        rentalRedirectUrl: rental.redirectUrl,
        depositRedirectUrl: deposit?.redirectUrl,
      }
    }

    const result: AuthorizeBookingFinancialsResult = {
      workflowId,
      status: 'completed',
      rentalPaymentId,
      rentalStatus: rental.status,
      depositPaymentId,
      depositStatus: deposit?.status ?? null,
    }

    await admin.rpc('update_financial_workflow_progress', {
      p_workflow_id: workflowId,
      p_status: 'completed',
      p_current_step: 'done',
      p_result: result,
    })

    return result
  } catch (err) {
    if (err instanceof OrchestrationError) throw err
    throw new OrchestrationError('internal_consistency_error', err instanceof Error ? err.message : String(err))
  }
}

async function ensureRentalCharged(
  admin: OrchestratorContext['admin'],
  provider: ReturnType<typeof getPaymentProvider>,
  workflowId: string,
  bookingId: string,
  paymentId: string,
  testScenario?: MockScenario
): Promise<StepOutcome> {
  const { data: payment } = await admin.from('payments').select('status, amount, currency').eq('id', paymentId).maybeSingle()
  if (payment?.status === 'captured') {
    // Step 11 Phase 7: re-attempted on every replay -- see the matching
    // comment in charge-order-payment.ts. Phase 2: same shape.
    await qualifyRentalPaymentAffiliateCommission(admin, bookingId, paymentId)
    await qualifyRentalPaymentUnityCommission(admin, bookingId, paymentId)
    // Phase 3: best-effort, never blocks -- a no-op unless ESCROW_ENABLED.
    try {
      await createEscrowForPayment(admin, { transactionType: 'rental', bookingId, paymentId, principalAmount: Number(payment.amount), currency: payment.currency })
      await fundEscrowForPayment(admin, paymentId)
    } catch (escrowErr) {
      console.error('[bookings.authorize-financials] escrow best-effort step failed', { bookingId, paymentId, escrowErr })
    }
    return { status: payment.status }
  }

  // P5C.1: reject a retry outright rather than creating a second live
  // Hosted Checkout session while an earlier attempt's session is still
  // open (payment.status stays 'pending' for a requires_action outcome,
  // so the check above alone can't distinguish "never attempted" from
  // "attempted, awaiting the shopper").
  await assertNoPendingProviderAttempt(admin, paymentId)

  await admin.rpc('update_financial_workflow_progress', { p_workflow_id: workflowId, p_status: 'processing', p_current_step: 'rental_authorization' })

  try {
    const charge = await provider.chargeRental({ paymentId, providerReference: '', amount: Number(payment?.amount ?? 0), currency: payment?.currency ?? 'ZAR', mockScenario: testScenario })

    if (charge.status === 'requires_action') {
      // Persist the provider reference (so P5D can later resolve this
      // exact session) via the same existing, safe mechanism every other
      // attempt already uses -- record_payment_attempt's own
      // provider_reference column. payments.status is deliberately left
      // untouched (still 'pending') -- no transition_payment_status call
      // here, and this is not a workflow failure, so failWorkflow() is
      // not called either.
      await admin.rpc('record_payment_attempt', {
        p_payment_id: paymentId,
        p_attempt_number: 1,
        p_provider: provider.name,
        p_status: 'pending',
        p_provider_reference: charge.providerReference,
        p_failure_message: null,
      })
      return { status: 'requires_action', redirectUrl: charge.redirectUrl }
    }

    await admin.rpc('record_payment_attempt', {
      p_payment_id: paymentId,
      p_attempt_number: 1,
      p_provider: provider.name,
      p_status: charge.status === 'captured' ? 'succeeded' : 'failed',
      p_provider_reference: charge.providerReference,
      p_failure_message: charge.status === 'failed' ? (charge.failureReason ?? null) : null,
    })

    if (charge.status === 'failed') {
      // Persist the decline on the payment itself, not just the workflow --
      // otherwise payments.status stays "pending" forever and every
      // renter-facing surface (checkout's failure summary, the dashboards)
      // has no durable signal that this payment was ever attempted.
      await admin.rpc('transition_payment_status', {
        p_payment_id: paymentId,
        p_new_status: 'failed',
        p_failure_reason: charge.failureReason ?? 'rental charge declined',
        p_actor_type: 'system',
      })
      await failWorkflow(admin, workflowId, 'failed_terminal', 'provider_declined', charge.failureReason ?? 'rental charge declined')
      throw new OrchestrationError('provider_declined', charge.failureReason ?? 'Rental charge was declined')
    }

    await admin.rpc('transition_payment_status', {
      p_payment_id: paymentId,
      p_new_status: 'captured',
      p_provider_reference: charge.providerReference,
      p_actor_type: 'system',
    })

    // Step 11 Phase 7: best-effort, never throws -- see charge-order-payment.ts.
    // Phase 2: Unity commission qualification is the same best-effort shape.
    await qualifyRentalPaymentAffiliateCommission(admin, bookingId, paymentId)
    await qualifyRentalPaymentUnityCommission(admin, bookingId, paymentId)

    // Phase 3: escrow custody is best-effort and additive -- never blocks
    // or fails the booking's own financial authorization, and is a no-op
    // unless ESCROW_ENABLED.
    try {
      await createEscrowForPayment(admin, { transactionType: 'rental', bookingId, paymentId, principalAmount: Number(payment?.amount ?? 0), currency: payment?.currency ?? 'ZAR' })
      await fundEscrowForPayment(admin, paymentId)
    } catch (escrowErr) {
      console.error('[bookings.authorize-financials] escrow best-effort step failed', { bookingId, paymentId, escrowErr })
    }

    return { status: 'captured' }
  } catch (err) {
    throw await handleProviderError(admin, workflowId, err)
  }
}

async function ensureDepositAuthorised(
  admin: OrchestratorContext['admin'],
  provider: ReturnType<typeof getPaymentProvider>,
  workflowId: string,
  paymentId: string,
  testScenario?: MockScenario
): Promise<StepOutcome> {
  const { data: payment } = await admin.from('payments').select('status, amount, currency').eq('id', paymentId).maybeSingle()
  if (payment?.status === 'authorised') return { status: payment.status }

  await assertNoPendingProviderAttempt(admin, paymentId)

  await admin.rpc('update_financial_workflow_progress', { p_workflow_id: workflowId, p_status: 'processing', p_current_step: 'deposit_authorization' })

  try {
    const auth = await provider.authorizeDeposit({ paymentId, providerReference: '', amount: Number(payment?.amount ?? 0), currency: payment?.currency ?? 'ZAR', mockScenario: testScenario })

    if (auth.status === 'requires_action') {
      await admin.rpc('record_payment_attempt', {
        p_payment_id: paymentId,
        p_attempt_number: 1,
        p_provider: provider.name,
        p_status: 'pending',
        p_provider_reference: auth.providerReference,
        p_failure_message: null,
      })
      return { status: 'requires_action', redirectUrl: auth.redirectUrl }
    }

    await admin.rpc('record_payment_attempt', {
      p_payment_id: paymentId,
      p_attempt_number: 1,
      p_provider: provider.name,
      p_status: auth.status === 'authorised' ? 'succeeded' : 'failed',
      p_provider_reference: auth.providerReference,
      p_failure_message: auth.status === 'failed' ? (auth.failureReason ?? null) : null,
    })

    if (auth.status === 'failed') {
      await admin.rpc('transition_payment_status', {
        p_payment_id: paymentId,
        p_new_status: 'failed',
        p_failure_reason: auth.failureReason ?? 'deposit authorization declined',
        p_actor_type: 'system',
      })
      await failWorkflow(admin, workflowId, 'failed_terminal', 'provider_declined', auth.failureReason ?? 'deposit authorization declined')
      throw new OrchestrationError('provider_declined', auth.failureReason ?? 'Deposit authorization was declined')
    }

    await admin.rpc('transition_payment_status', {
      p_payment_id: paymentId,
      p_new_status: 'authorised',
      p_provider_reference: auth.providerReference,
      p_actor_type: 'system',
    })
    return { status: 'authorised' }
  } catch (err) {
    throw await handleProviderError(admin, workflowId, err)
  }
}

async function handleProviderError(admin: OrchestratorContext['admin'], workflowId: string, err: unknown): Promise<OrchestrationError> {
  if (err instanceof OrchestrationError) return err

  let code: OrchestrationErrorCode = 'internal_consistency_error'
  let workflowStatus: 'failed_retryable' | 'failed_terminal' = 'failed_terminal'

  if (err instanceof ProviderTimeoutError) {
    code = 'provider_timeout'
    workflowStatus = 'failed_retryable'
  } else if (err instanceof RetryableProviderError) {
    code = 'retryable_provider_error'
    workflowStatus = 'failed_retryable'
  } else if (err instanceof TerminalProviderError) {
    code = 'terminal_provider_error'
    workflowStatus = 'failed_terminal'
  }

  const message = err instanceof Error ? err.message : String(err)
  await failWorkflow(admin, workflowId, workflowStatus, code, message)
  return new OrchestrationError(code, message)
}

async function failWorkflow(
  admin: OrchestratorContext['admin'],
  workflowId: string,
  status: 'failed_retryable' | 'failed_terminal',
  errorCode: string,
  errorMessage: string
): Promise<void> {
  await admin.rpc('update_financial_workflow_progress', {
    p_workflow_id: workflowId,
    p_status: status,
    p_last_error_code: errorCode,
    p_last_error_message: errorMessage,
  })
}
