import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    return NextResponse.json({ ok: false }, { status: 200 }) // Silent fail in mock/unconfigured mode
  }

  let body: { affiliateCode?: string; listingId?: string; commissionRate?: number; rentalFee?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { affiliateCode, listingId, commissionRate, rentalFee } = body
  if (!affiliateCode || !listingId || commissionRate == null || rentalFee == null) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }

  const admin = createClient(url, serviceKey)

  // Look up the affiliate's profile ID from their code
  const { data: affiliateProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('affiliate_code', affiliateCode)
    .single()

  if (!affiliateProfile) {
    return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 })
  }

  const commissionAmount = Math.round(rentalFee * (commissionRate / 100) * 100) / 100

  const { error } = await admin.from('affiliate_referrals').insert({
    affiliate_id: affiliateProfile.id,
    listing_id: listingId,
    commission_amount: commissionAmount,
    status: 'pending',
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, commission_amount: commissionAmount })
}
