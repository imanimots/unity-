import { NextRequest, NextResponse } from 'next/server'
import { AFFILIATE_SWEEP_BATCH_LIMIT } from '@/lib/affiliate/constants'
import { notifyAffiliateOfCommission } from '@/lib/affiliate/notify'

/** POST /api/internal/affiliate/queue-payouts -- approved -> payout_queued, bounded batch. */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal affiliate payout-queue endpoint is not configured' }, { status: 503 })
  }
  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data: candidates, error: selectError } = await admin
      .from('affiliate_commissions')
      .select('id')
      .eq('status', 'approved')
      .limit(AFFILIATE_SWEEP_BATCH_LIMIT)

    if (selectError) {
      console.error('[internal.affiliate.queue-payouts] select error', selectError)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }

    let queuedCount = 0
    for (const row of candidates ?? []) {
      const { data, error } = await admin.rpc('queue_affiliate_payout', { p_commission_id: row.id })
      if (error) {
        console.error('[internal.affiliate.queue-payouts] queue error', { commissionId: row.id, error })
        continue
      }
      if (data?.status === 'payout_queued') {
        queuedCount++
        try {
          await notifyAffiliateOfCommission(admin, row.id, 'affiliate.payout_queued', 'affiliate-payout-queued')
        } catch (emailErr) {
          console.error('[internal.affiliate.queue-payouts] email dispatch failed', { commissionId: row.id, emailErr })
        }
      }
    }

    return NextResponse.json({ considered: (candidates ?? []).length, queued: queuedCount })
  } catch (err) {
    console.error('[internal.affiliate.queue-payouts] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
