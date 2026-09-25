import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { getPaymentProvider } from '@/lib/payments/registry'
import { assertNoPendingProviderAttempt } from '@/lib/payments/orchestrator/pending-provider-attempt-guard'
import { z } from 'zod'

interface RouteParams {
  params: Promise<{ id: string }>
}

const bodySchema = z.object({ idempotency_key: z.string().min(1).max(200).optional(), test_scenario: z.enum(['success', 'declined']).optional() })

/**
 * POST .../payoff -- only the "remaining contractual balance" flavor
 * (Rule 13). A single provider charge for the remaining balance, then
 * payoff_rent_to_buy_agreement() marks every remaining instalment paid
 * via that one payment reference and runs the ownership-transfer check.
 *
 * P5D-B.2: the exact set of currently-scheduled installments (sequence +
 * principal_amount, not just their sum) is now read ONCE here, server-
 * side, before any provider handoff, and passed to
 * create_rent_to_buy_payment_intent as p_payoff_sequences -- the durable
 * snapshot P5D-M3's payoff_rent_to_buy_agreement completes from later,
 * never a live re-query of "whatever is still scheduled" at completion
 * time. The client never supplies this array.
 *
 * P5D-B.2 CRITICAL FIX: the prior version treated ANY non-'failed'
 * chargeRental() result as financial success, including
 * 'requires_action' -- which PeachProvider ALWAYS returns on success
 * (never 'captured' synchronously; see peach-provider.ts's own class
 * comment). That meant a live payoff attempt would mark the payment
 * captured, mark every installment paid, and transfer ownership BEFORE
 * the shopper ever completed Hosted Checkout -- a full ownership
 * transfer with zero money collected. Fixed by branching on
 * charge.status exactly like chargeRentToBuyInstallment()/
 * chargeRentToBuyDeposit() already do: 'requires_action' stays pending
 * and returns the redirect information for the shopper; only a genuine
 * 'captured' result transitions the payment and invokes payoff
 * completion.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const rate = await checkRateLimit(`rent-to-buy:payoff:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch { body = {} }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data: agreement } = await admin.from('rent_to_buy_agreements').select('customer_id, merchant_id, currency').eq('id', id).maybeSingle()
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 })
  if (agreement.customer_id !== requester.userId) return NextResponse.json({ error: 'You are not the customer of this agreement' }, { status: 403 })

  // Authoritative payoff snapshot -- exact sequence + principal_amount for
  // every currently-scheduled installment, server-generated, before any
  // provider handoff. create_rent_to_buy_payment_intent independently
  // re-validates this exact set (agreement, scheduled status,
  // cardinality, amount) -- this route never asks the RPC to trust it.
  const { data: remainingRows } = await admin
    .from('rent_to_buy_installments')
    .select('sequence, principal_amount')
    .eq('agreement_id', id)
    .eq('status', 'scheduled')
    .order('sequence', { ascending: true })
  const payoffSequences = (remainingRows ?? []).map((r) => r.sequence as number)
  const remaining = (remainingRows ?? []).reduce((sum, r) => sum + Number(r.principal_amount), 0)
  if (payoffSequences.length === 0 || remaining <= 0) return NextResponse.json({ error: 'There is no remaining balance to pay off' }, { status: 409 })

  const providerName = process.env.PAYMENT_PROVIDER || 'mock'
  const provider = getPaymentProvider(providerName)

  const { data: intent, error: intentError } = await admin.rpc('create_rent_to_buy_payment_intent', {
    p_rent_to_buy_agreement_id: id,
    p_payer_id: agreement.customer_id,
    p_counterparty_id: agreement.merchant_id,
    p_payment_type: 'rent_to_buy_installment',
    p_amount: remaining,
    p_currency: agreement.currency,
    p_provider: providerName,
    p_idempotency_key: parsed.data.idempotency_key ? `${parsed.data.idempotency_key}-intent` : null,
    p_payoff_sequences: payoffSequences,
  })
  if (intentError) {
    const mapped = mapRentToBuyRpcError(intentError.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  const paymentId = intent.payment_id as string

  const { data: paymentRow } = await admin.from('payments').select('status').eq('id', paymentId).maybeSingle()
  if (paymentRow?.status === 'captured') {
    // Already financially captured on a prior attempt (e.g. the client
    // retried after losing the response) -- never call the provider
    // again. payoff_rent_to_buy_agreement is itself idempotent (P5D-M3):
    // a genuine retry here safely resolves to completed/already_completed
    // without a second charge.
    return respondWithPayoffCompletion(admin, requester.userId, id, paymentId)
  }

  await assertNoPendingProviderAttempt(admin, paymentId)

  const charge = await provider.chargeRental({ paymentId, providerReference: '', amount: remaining, currency: agreement.currency, mockScenario: parsed.data.test_scenario })

  if (charge.status === 'requires_action') {
    await admin.rpc('record_payment_attempt', {
      p_payment_id: paymentId,
      p_attempt_number: 1,
      p_provider: provider.name,
      p_status: 'pending',
      p_provider_reference: charge.providerReference,
      p_failure_code: null,
      p_failure_message: null,
    })
    return NextResponse.json({ paymentId, status: 'requires_action', redirectUrl: charge.redirectUrl })
  }

  await admin.rpc('record_payment_attempt', {
    p_payment_id: paymentId,
    p_attempt_number: 1,
    p_provider: provider.name,
    p_status: charge.status === 'captured' ? 'succeeded' : 'failed',
    p_provider_reference: charge.providerReference,
    p_failure_code: charge.status === 'failed' ? 'provider_declined' : null,
    p_failure_message: charge.status === 'failed' ? (charge.failureReason ?? null) : null,
  })

  if (charge.status === 'failed') {
    await admin.rpc('transition_payment_status', { p_payment_id: paymentId, p_new_status: 'failed', p_failure_reason: charge.failureReason ?? 'payoff declined', p_actor_type: 'system' })
    return NextResponse.json({ error: charge.failureReason ?? 'Payment was declined' }, { status: 402 })
  }

  await admin.rpc('transition_payment_status', { p_payment_id: paymentId, p_new_status: 'captured', p_provider_reference: charge.providerReference, p_actor_type: 'system' })

  return respondWithPayoffCompletion(admin, requester.userId, id, paymentId)
}

/**
 * Invokes the P5D-M3 completion RPC and maps its structured outcomes to
 * an HTTP response. `completed`/`already_completed` are success;
 * `payment_conflict`/`invalid_snapshot` are a PERMANENT business-state
 * conflict the RPC itself guarantees performed no write (no installment
 * mutation, no ownership transfer) -- never silently reported as a
 * normal payoff, never auto-refunded/credited. Logged the same way
 * reconcileOrchestrationPayment's own manual_review outcomes already
 * are (structured console.error + the durable audit trail already
 * written for this request) -- no other "flag for review" mechanism
 * exists in this codebase without a new migration.
 */
async function respondWithPayoffCompletion(admin: SupabaseClient, actorUserId: string, agreementId: string, paymentId: string): Promise<NextResponse> {
  const { data, error } = await admin.rpc('payoff_rent_to_buy_agreement', {
    p_actor_user_id: actorUserId,
    p_agreement_id: agreementId,
    p_payment_id: paymentId,
  })
  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  const status = (data as { status?: string } | null)?.status
  if (status === 'completed' || status === 'already_completed') {
    return NextResponse.json(data)
  }

  console.error('[rent-to-buy.payoff] payoff completion could not proceed safely', { agreementId, paymentId, result: data })
  return NextResponse.json(
    { error: 'Your payment was received but could not be automatically finalized. Our team has been notified and will resolve this shortly.', status, payment_id: paymentId },
    { status: 409 }
  )
}
