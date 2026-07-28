import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'

const bodySchema = z.object({
  affiliateCode: z.string().min(1).max(64),
  listingId: z.string().uuid(),
  rentalFee: z.number().positive().max(1_000_000),
})

export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    return NextResponse.json({ ok: false }, { status: 200 }) // Silent no-op in unconfigured mode
  }

  const rate = checkRateLimit(`referral:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  // Referrals are recorded off the back of a real booking checkout, so the
  // caller must be an authenticated renter — not an arbitrary anonymous POST.
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid fields', issues: parsed.error.issues }, { status: 400 })
  }
  const { affiliateCode, listingId, rentalFee } = parsed.data

  const admin = createClient(url, serviceKey)

  const { data: affiliateProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('affiliate_code', affiliateCode)
    .single()

  if (!affiliateProfile) {
    return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 })
  }

  // Never trust a client-supplied commission rate — always read it from the
  // listing itself, and confirm the listing actually accepts affiliates.
  const { data: listing } = await admin
    .from('listings')
    .select('id, accepts_affiliates, affiliate_commission_rate')
    .eq('id', listingId)
    .single()

  if (!listing || !listing.accepts_affiliates) {
    return NextResponse.json({ error: 'Listing does not accept affiliate referrals' }, { status: 400 })
  }

  const commissionAmount = Math.round(rentalFee * (listing.affiliate_commission_rate / 100) * 100) / 100

  const { error } = await admin.from('affiliate_referrals').insert({
    affiliate_id: affiliateProfile.id,
    listing_id: listingId,
    commission_amount: commissionAmount,
    status: 'pending',
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, commission_amount: commissionAmount })
}
