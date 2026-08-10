import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { chargeRentToBuyInstallment } from '@/lib/payments/orchestrator/charge-rent-to-buy-installment'
import { OrchestrationError } from '@/lib/payments/orchestrator/errors'
import { notifyRentToBuyParty } from '@/lib/rent-to-buy/notify'
import { z } from 'zod'

interface RouteParams {
  params: Promise<{ id: string }>
}

const bodySchema = z.object({
  sequence: z.number().int().positive(),
  idempotency_key: z.string().min(1).max(200).optional(),
  test_scenario: z.enum(['success', 'declined']).optional(),
})

/**
 * POST .../pay-installment -- the customer explicitly pays the next (or
 * a specific) scheduled instalment. Mirrors booking/order checkout's
 * own "the customer must explicitly act" pattern -- nothing here is
 * auto-charged. On success, record_rent_to_buy_installment_payment
 * (called inside the orchestrator) handles the first-payment ->
 * possession_eligible transition and the 100%-paid ownership-transfer
 * check atomically.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const rate = checkRateLimit(`rent-to-buy:pay-installment:${getClientKey(request)}`, 15, 60_000)
  if (!rate.allowed) return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data: agreement } = await admin.from('rent_to_buy_agreements').select('customer_id, merchant_id, status').eq('id', id).maybeSingle()
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 })
  if (agreement.customer_id !== requester.userId) return NextResponse.json({ error: 'You are not the customer of this agreement' }, { status: 403 })

  // A completed agreement (every installment already paid) still allows
  // an exact replay of an already-paid installment through -- the
  // orchestrator's own idempotent short-circuit handles it as a safe
  // no-op. Any other status transition attempt on a completed agreement
  // still isn't meaningful (there's nothing left to pay), so this
  // doesn't open a new mutation surface -- it only lets a genuine replay
  // avoid a false 409.
  const { data: targetInstallment } = await admin.from('rent_to_buy_installments').select('status').eq('agreement_id', id).eq('sequence', parsed.data.sequence).maybeSingle()
  const isReplayOfPaidInstallment = targetInstallment?.status === 'paid'
  if (agreement.status !== 'awaiting_first_payment' && agreement.status !== 'active' && !isReplayOfPaidInstallment) {
    return NextResponse.json({ error: `Agreement is in status ${agreement.status} and cannot accept a payment right now` }, { status: 409 })
  }

  try {
    const result = await chargeRentToBuyInstallment(
      { admin, testRentalScenario: parsed.data.test_scenario },
      id,
      parsed.data.sequence,
      parsed.data.idempotency_key
    )

    if (parsed.data.sequence === 1) {
      await notifyRentToBuyParty(admin, id, agreement.customer_id, 'rent_to_buy.agreement_accepted', 'rent-to-buy-agreement-accepted', `rtb-accepted-${id}`)
      await notifyRentToBuyParty(admin, id, agreement.customer_id, 'rent_to_buy.first_payment_settled', 'rent-to-buy-possession-eligible', `rtb-possession-eligible-${id}`)
    }

    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof OrchestrationError) {
      const status = err.code === 'provider_declined' || err.code === 'retryable_provider_error' ? 402 : 500
      return NextResponse.json({ error: err.message }, { status })
    }
    console.error('[rent-to-buy.pay-installment] unexpected error', { agreementId: id, err })
    return NextResponse.json({ error: 'Could not process your payment — please try again' }, { status: 500 })
  }
}
