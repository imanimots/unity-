import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { chargeRentToBuyDeposit } from '@/lib/payments/orchestrator/charge-rent-to-buy-deposit'
import { OrchestrationError } from '@/lib/payments/orchestrator/errors'
import { z } from 'zod'

interface RouteParams {
  params: Promise<{ id: string }>
}

const bodySchema = z.object({
  idempotency_key: z.string().min(1).max(200).optional(),
  test_scenario: z.enum(['success', 'declined']).optional(),
})

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })

  const rate = checkRateLimit(`rent-to-buy:pay-deposit:${getClientKey(request)}`, 15, 60_000)
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

  const { data: agreement } = await admin.from('rent_to_buy_agreements').select('customer_id').eq('id', id).maybeSingle()
  if (!agreement) return NextResponse.json({ error: 'Agreement not found' }, { status: 404 })
  if (agreement.customer_id !== requester.userId) return NextResponse.json({ error: 'You are not the customer of this agreement' }, { status: 403 })

  try {
    const result = await chargeRentToBuyDeposit({ admin, testDepositScenario: parsed.data.test_scenario }, id, parsed.data.idempotency_key)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof OrchestrationError) {
      const status = err.code === 'provider_declined' || err.code === 'retryable_provider_error' ? 402 : err.code === 'invalid_booking_state' ? 422 : 500
      return NextResponse.json({ error: err.message }, { status })
    }
    console.error('[rent-to-buy.pay-deposit] unexpected error', { agreementId: id, err })
    return NextResponse.json({ error: 'Could not process your payment — please try again' }, { status: 500 })
  }
}
