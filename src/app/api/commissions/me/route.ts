import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

/**
 * GET /api/commissions/me -- the caller's OWN Unity commissions, scoped
 * by merchant_id = requester.userId at every query, never another
 * merchant's data. Read-only; merchants cannot mutate a commission.
 * Mirrors GET /api/payouts/me's exact shape. Also surfaces each
 * commission's associated affiliate reward (if any) so the merchant can
 * see the full "gross - Unity commission - affiliate reward = proceeds"
 * picture in one place (Step I) without exposing admin-only reason
 * data (hold_reason/void_reason are intentionally never returned).
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Commission storage is not configured' }, { status: 503 })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(url, serviceKey)

  const { data: commissions, error } = await admin
    .from('unity_commissions')
    .select('id, transaction_type, status, order_id, booking_id, payment_id, listing_id, eligible_base, standard_rate_bps, standard_rate_base, excess_rate_bps, excess_base, commission_amount, currency, created_at, earned_at')
    .eq('merchant_id', requester.userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[commissions.me] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load your commissions' }, { status: 500 })
  }

  const listingIds = Array.from(new Set((commissions ?? []).map((c) => c.listing_id)))
  const paymentIds = (commissions ?? []).map((c) => c.payment_id)
  const orderIds = (commissions ?? []).map((c) => c.order_id).filter((id): id is string => !!id)
  const bookingIds = (commissions ?? []).map((c) => c.booking_id).filter((id): id is string => !!id)

  const [{ data: listings }, { data: affiliateCommissions }, { data: orders }, { data: bookings }] = await Promise.all([
    listingIds.length ? admin.from('listings').select('id, title').in('id', listingIds) : Promise.resolve({ data: [] }),
    paymentIds.length ? admin.from('affiliate_commissions').select('payment_id, commission_amount, status').in('payment_id', paymentIds) : Promise.resolve({ data: [] }),
    orderIds.length ? admin.from('orders').select('id, order_reference').in('id', orderIds) : Promise.resolve({ data: [] }),
    bookingIds.length ? admin.from('bookings').select('id, booking_reference').in('id', bookingIds) : Promise.resolve({ data: [] }),
  ])

  const listingTitleById = new Map((listings ?? []).map((l) => [l.id, l.title]))
  const affiliateRewardByPayment = new Map((affiliateCommissions ?? []).filter((a) => a.status !== 'voided').map((a) => [a.payment_id, a.commission_amount]))
  const orderReferenceById = new Map((orders ?? []).map((o) => [o.id, o.order_reference]))
  const bookingReferenceById = new Map((bookings ?? []).map((b) => [b.id, b.booking_reference]))

  const shaped = (commissions ?? []).map((c) => {
    const affiliateReward = affiliateRewardByPayment.get(c.payment_id) ?? 0
    const merchantProceedsBasis = Number(c.eligible_base) - Number(c.commission_amount) - Number(affiliateReward)
    return {
      id: c.id,
      transactionType: c.transaction_type,
      status: c.status,
      reference: c.order_id ? orderReferenceById.get(c.order_id) : c.booking_id ? bookingReferenceById.get(c.booking_id) : null,
      listingTitle: listingTitleById.get(c.listing_id) ?? null,
      eligibleBase: c.eligible_base,
      standardRateBps: c.standard_rate_bps,
      standardRateBase: c.standard_rate_base,
      excessRateBps: c.excess_rate_bps,
      excessBase: c.excess_base,
      commissionAmount: c.commission_amount,
      affiliateReward,
      merchantProceedsBasis,
      currency: c.currency,
      createdAt: c.created_at,
      earnedAt: c.earned_at,
    }
  })

  return NextResponse.json({ commissions: shaped })
}
