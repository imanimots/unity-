import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { getPaymentProvider } from '@/lib/payments/registry'
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
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const rate = checkRateLimit(`rent-to-buy:payoff:${getClientKey(request)}`, 10, 60_000)
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

  const { data: remainingRows } = await admin.from('rent_to_buy_installments').select('principal_amount').eq('agreement_id', id).eq('status', 'scheduled')
  const remaining = (remainingRows ?? []).reduce((sum, r) => sum + Number(r.principal_amount), 0)
  if (remaining <= 0) return NextResponse.json({ error: 'There is no remaining balance to pay off' }, { status: 409 })

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
  })
  if (intentError) {
    const mapped = mapRentToBuyRpcError(intentError.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  const paymentId = intent.payment_id as string

  const charge = await provider.chargeRental({ paymentId, providerReference: '', amount: 0, currency: 'ZAR', mockScenario: parsed.data.test_scenario })
  if (charge.status === 'failed') {
    await admin.rpc('transition_payment_status', { p_payment_id: paymentId, p_new_status: 'failed', p_failure_reason: charge.failureReason ?? 'payoff declined', p_actor_type: 'system' })
    return NextResponse.json({ error: charge.failureReason ?? 'Payment was declined' }, { status: 402 })
  }
  await admin.rpc('transition_payment_status', { p_payment_id: paymentId, p_new_status: 'captured', p_provider_reference: charge.providerReference, p_actor_type: 'system' })

  const { data, error } = await admin.rpc('payoff_rent_to_buy_agreement', {
    p_actor_user_id: requester.userId,
    p_agreement_id: id,
    p_payment_id: paymentId,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })
  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data)
}
