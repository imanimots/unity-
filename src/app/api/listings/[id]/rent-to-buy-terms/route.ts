import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { saveRentToBuyListingTermsSchema } from '@/lib/rent-to-buy/validation'
import { mapRentToBuyRpcError } from '@/lib/rent-to-buy/rpc-errors'
import { isRentToBuyEnabled } from '@/lib/rent-to-buy/config'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET/POST /api/listings/[id]/rent-to-buy-terms -- merchant configures
 * their own listing's rent-to-buy terms. Enabling (enabled: true) is
 * blocked while RENT_TO_BUY_ENABLED is off (Rule M) -- disabling terms
 * on an existing listing, or editing while already enabled, is not
 * blocked by the flag, only the transition INTO enabled=true is.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data, error } = await admin.from('rent_to_buy_listing_terms').select('*').eq('listing_id', id).maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not load terms' }, { status: 500 })
  return NextResponse.json({ terms: data ?? null })
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = saveRentToBuyListingTermsSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid terms', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })

  if (parsed.data.enabled && !isRentToBuyEnabled()) {
    return NextResponse.json({ error: 'Rent-to-buy is not currently available' }, { status: 503 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data, error } = await admin.rpc('save_rent_to_buy_listing_terms', {
    p_merchant_id: requester.userId,
    p_listing_id: id,
    p_enabled: parsed.data.enabled,
    p_currency: parsed.data.currency ?? 'ZAR',
    p_total_purchase_price: parsed.data.total_purchase_price,
    p_installment_amount: parsed.data.installment_amount,
    p_payment_frequency: parsed.data.payment_frequency,
    p_installment_count: parsed.data.installment_count,
    p_security_deposit_amount: parsed.data.security_deposit_amount ?? null,
    p_early_payoff_allowed: parsed.data.early_payoff_allowed ?? false,
    p_early_payoff_policy: parsed.data.early_payoff_policy ?? null,
    p_default_cure_allowed: parsed.data.default_cure_allowed ?? false,
    p_cure_policy: parsed.data.cure_policy ?? null,
    p_possession_trigger_type: parsed.data.possession_trigger_type,
    p_possession_trigger_value: parsed.data.possession_trigger_value ?? null,
    p_rental_use_rate_amount: parsed.data.rental_use_rate_amount,
    p_rental_use_rate_unit: parsed.data.rental_use_rate_unit,
    p_wear_damage_standard: parsed.data.wear_damage_standard ?? null,
    p_grace_period_days: parsed.data.grace_period_days,
    p_return_window_days: parsed.data.return_window_days,
  })

  if (error) {
    const mapped = mapRentToBuyRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data)
}
