import type { SupabaseClient } from '@supabase/supabase-js'
import { isEscrowEnabled } from './config'
import { getEscrowProvider } from './registry'
import type { EscrowMockScenario, EscrowTransactionType } from './provider'
import { sendTemplate } from '@/lib/email'

/**
 * Escrow orchestrator -- coordinates escrow_transactions without coupling
 * any existing checkout/completion flow to a specific escrow provider.
 * Mirrors src/lib/payments/orchestrator/'s shape at a smaller scale (4
 * functions instead of ~10, since escrow's lifecycle is simpler than a
 * full payment workflow).
 *
 * Every function here early-returns `null` when isEscrowEnabled() is
 * false, so a call site can invoke them unconditionally -- the caller
 * never needs its own `if (escrowEnabled)` branch, and when the flag is
 * off every existing flow is byte-identical to before Phase 3 existed.
 *
 * Callable only from trusted server-side code (a service-role Supabase
 * client is required) -- same trust boundary as the payments orchestrator.
 */

export type EscrowOrchestrationErrorCode = 'provider_declined' | 'provider_unavailable' | 'provider_timeout' | 'retryable_provider_error' | 'terminal_provider_error' | 'internal_consistency_error' | 'not_eligible'

export class EscrowOrchestrationError extends Error {
  readonly code: EscrowOrchestrationErrorCode
  constructor(code: EscrowOrchestrationErrorCode, message: string) {
    super(message)
    this.name = 'EscrowOrchestrationError'
    this.code = code
  }
}

export interface CreateEscrowForPaymentInput {
  transactionType: EscrowTransactionType
  orderId?: string
  bookingId?: string
  barterAgreementId?: string
  rentToBuyAgreementId?: string
  paymentId: string
  principalAmount: number
  secureTransactionFeeAmount?: number
  currency?: string
  mockScenario?: EscrowMockScenario
}

export interface EscrowTransactionResult {
  escrowTransactionId: string
  status: string
}

/**
 * Called right after the underlying payment INTENT is created (never
 * after capture -- funding is a separate step, see
 * fundEscrowForPayment()). Never recalculates commission or affiliate
 * reward -- principalAmount is always passed in by the caller, already
 * derived from the same authoritative source (the payment's own amount)
 * every other domain in this codebase already uses.
 */
export async function createEscrowForPayment(admin: SupabaseClient, input: CreateEscrowForPaymentInput): Promise<EscrowTransactionResult | null> {
  if (!isEscrowEnabled()) return null

  const provider = getEscrowProvider()
  let providerResult
  try {
    providerResult = await provider.createEscrowTransaction({
      transactionType: input.transactionType,
      principalAmount: input.principalAmount,
      secureTransactionFeeAmount: input.secureTransactionFeeAmount ?? 0,
      currency: input.currency ?? 'ZAR',
      mockScenario: input.mockScenario,
    })
  } catch (err) {
    throw translateProviderError(provider.name, 'createEscrowTransaction', err)
  }

  const { data, error } = await admin.rpc('create_escrow_transaction', {
    p_transaction_type: input.transactionType,
    p_order_id: input.orderId ?? null,
    p_booking_id: input.bookingId ?? null,
    p_barter_agreement_id: input.barterAgreementId ?? null,
    p_payment_id: input.paymentId,
    p_principal_amount: input.principalAmount,
    p_secure_transaction_fee_amount: input.secureTransactionFeeAmount ?? 0,
    p_currency: input.currency ?? 'ZAR',
    p_provider: provider.name,
    p_provider_reference: providerResult.providerReference,
    p_rent_to_buy_agreement_id: input.rentToBuyAgreementId ?? null,
  })

  if (error) throw new EscrowOrchestrationError('internal_consistency_error', error.message)
  return { escrowTransactionId: data.id, status: data.status }
}

/**
 * Called right after the underlying payment's own capture already
 * succeeded (best-effort, never blocks the payment flow that calls it).
 * A no-op (returns null) if escrow is disabled or no escrow transaction
 * was ever created for this payment.
 */
export async function fundEscrowForPayment(admin: SupabaseClient, paymentId: string, mockScenario?: EscrowMockScenario): Promise<EscrowTransactionResult | null> {
  if (!isEscrowEnabled()) return null

  const { data: escrow } = await admin
    .from('escrow_transactions')
    .select('id, status, provider_reference, principal_amount, currency')
    .eq('payment_id', paymentId)
    .maybeSingle()
  if (!escrow) return null
  if (escrow.status !== 'pending') return { escrowTransactionId: escrow.id, status: escrow.status }

  const provider = getEscrowProvider()
  let result
  try {
    result = await provider.fundEscrowTransaction({
      providerReference: escrow.provider_reference,
      amount: Number(escrow.principal_amount),
      currency: escrow.currency,
      mockScenario,
    })
  } catch (err) {
    throw translateProviderError(provider.name, 'fundEscrowTransaction', err)
  }
  if (result.status === 'failed') {
    throw new EscrowOrchestrationError('provider_declined', result.failureReason ?? 'escrow funding was declined')
  }

  const { data, error } = await admin.rpc('mark_escrow_funded', {
    p_escrow_id: escrow.id,
    p_provider_reference: result.providerReference,
  })
  if (error) throw new EscrowOrchestrationError('internal_consistency_error', error.message)
  return { escrowTransactionId: data.escrow_transaction_id, status: data.status }
}

export interface ReleaseEscrowForPaymentOptions {
  actorType?: 'system' | 'admin'
  actorId?: string
  reason?: string
  mockScenario?: EscrowMockScenario
}

/**
 * Called at the transaction's own completion point (booking confirm-
 * return, order confirm-delivery, barter confirm-completion) or from a
 * narrow admin override route. Blocked server-side by
 * _escrow_transaction_dispute_block() -- this function never bypasses
 * that check. A no-op (returns null) if escrow is disabled, no escrow
 * transaction exists for this payment, or it isn't currently 'funded'.
 */
export async function releaseEscrowForPayment(
  admin: SupabaseClient,
  paymentId: string,
  releasedTo: string,
  opts: ReleaseEscrowForPaymentOptions = {}
): Promise<EscrowTransactionResult | null> {
  if (!isEscrowEnabled()) return null

  const { data: escrow } = await admin
    .from('escrow_transactions')
    .select('id, status, provider_reference, principal_amount, currency')
    .eq('payment_id', paymentId)
    .maybeSingle()
  if (!escrow || escrow.status !== 'funded') return null

  const provider = getEscrowProvider()
  let result
  try {
    result = await provider.releaseEscrowTransaction({
      providerReference: escrow.provider_reference,
      amount: Number(escrow.principal_amount),
      currency: escrow.currency,
      mockScenario: opts.mockScenario,
    })
  } catch (err) {
    throw translateProviderError(provider.name, 'releaseEscrowTransaction', err)
  }
  if (result.status === 'failed') {
    throw new EscrowOrchestrationError('provider_declined', result.failureReason ?? 'escrow release was declined')
  }

  const { data, error } = await admin.rpc('release_escrow_transaction', {
    p_actor_type: opts.actorType ?? 'system',
    p_actor_id: opts.actorId ?? null,
    p_escrow_id: escrow.id,
    p_released_to: releasedTo,
    p_reason: opts.reason ?? null,
  })
  if (error) {
    if (error.message.includes('not currently eligible to release')) {
      throw new EscrowOrchestrationError('not_eligible', error.message)
    }
    throw new EscrowOrchestrationError('internal_consistency_error', error.message)
  }

  // Best-effort, never throws -- see docs/ESCROW_ARCHITECTURE.md. Uses
  // the existing email infrastructure only (sendTemplate/EMAIL_TEMPLATES),
  // never a new notification channel.
  try {
    await notifyEscrowReleased(admin, escrow.id, releasedTo)
  } catch (emailErr) {
    console.error('[escrow.orchestrator] release email dispatch failed', { escrowId: escrow.id, emailErr })
  }

  return { escrowTransactionId: data.escrow_transaction_id, status: data.status }
}

async function notifyEscrowReleased(admin: SupabaseClient, escrowTransactionId: string, recipientUserId: string): Promise<void> {
  const { data: escrow } = await admin.from('escrow_transactions').select('order_id, booking_id, barter_agreement_id, rent_to_buy_agreement_id').eq('id', escrowTransactionId).maybeSingle()
  if (!escrow) return

  let transactionReference: string | null = null
  if (escrow.order_id) {
    const { data } = await admin.from('orders').select('order_reference').eq('id', escrow.order_id).maybeSingle()
    transactionReference = data?.order_reference ?? null
  } else if (escrow.booking_id) {
    const { data } = await admin.from('bookings').select('booking_reference').eq('id', escrow.booking_id).maybeSingle()
    transactionReference = data?.booking_reference ?? null
  } else if (escrow.barter_agreement_id) {
    const { data } = await admin.from('barter_agreements').select('agreement_reference').eq('id', escrow.barter_agreement_id).maybeSingle()
    transactionReference = data?.agreement_reference ?? null
  } else if (escrow.rent_to_buy_agreement_id) {
    // rent_to_buy_agreements has no dedicated reference column -- use a
    // short id-derived label, consistent in shape with the others.
    transactionReference = `RTB-${escrow.rent_to_buy_agreement_id.slice(0, 8).toUpperCase()}`
  }
  if (!transactionReference) return

  const { data: recipient } = await admin.from('profiles').select('full_name, display_name').eq('id', recipientUserId).maybeSingle()
  const recipientName = recipient?.full_name ?? recipient?.display_name ?? 'there'

  await sendTemplate(admin, {
    eventType: 'escrow_transaction.released',
    templateId: 'escrow-transaction-released',
    recipientUserId,
    relatedEntityType: 'escrow_transaction',
    relatedEntityId: escrowTransactionId,
    occurrenceKey: 'released',
    vars: { recipientName, transactionReference },
  })
}

/**
 * Admin-only refund (no automatic refund trigger exists yet -- see
 * docs/ESCROW_ARCHITECTURE.md). Never blocked by a dispute.
 */
export async function refundEscrowTransaction(
  admin: SupabaseClient,
  escrowTransactionId: string,
  adminId: string,
  amount: number,
  reason: string,
  mockScenario?: EscrowMockScenario
): Promise<EscrowTransactionResult> {
  const { data: escrow } = await admin
    .from('escrow_transactions')
    .select('id, status, provider_reference, currency')
    .eq('id', escrowTransactionId)
    .maybeSingle()
  if (!escrow) throw new EscrowOrchestrationError('internal_consistency_error', 'escrow transaction not found')

  const provider = getEscrowProvider()
  let result
  try {
    result = await provider.refundEscrowTransaction({
      providerReference: escrow.provider_reference,
      amount,
      currency: escrow.currency,
      reason,
      mockScenario,
    })
  } catch (err) {
    throw translateProviderError(provider.name, 'refundEscrowTransaction', err)
  }
  if (result.status === 'failed') {
    throw new EscrowOrchestrationError('provider_declined', result.failureReason ?? 'escrow refund was declined')
  }

  const { data, error } = await admin.rpc('refund_escrow_transaction', {
    p_admin_id: adminId,
    p_escrow_id: escrowTransactionId,
    p_amount: amount,
    p_reason: reason,
  })
  if (error) throw new EscrowOrchestrationError('internal_consistency_error', error.message)
  return { escrowTransactionId: data.escrow_transaction_id, status: data.status }
}

function translateProviderError(providerName: string, operation: string, err: unknown): EscrowOrchestrationError {
  const name = err instanceof Error ? err.name : ''
  if (name === 'EscrowProviderTimeoutError') return new EscrowOrchestrationError('provider_timeout', `${providerName} timed out during ${operation}`)
  if (name === 'EscrowRetryableProviderError') return new EscrowOrchestrationError('retryable_provider_error', `${providerName} returned a retryable error during ${operation}`)
  if (name === 'EscrowTerminalProviderError') return new EscrowOrchestrationError('terminal_provider_error', `${providerName} returned a terminal error during ${operation}`)
  if (name === 'EscrowNotImplementedError') return new EscrowOrchestrationError('provider_unavailable', err instanceof Error ? err.message : `${providerName} does not implement ${operation}`)
  return new EscrowOrchestrationError('internal_consistency_error', err instanceof Error ? err.message : String(err))
}
