import { NextRequest, NextResponse } from 'next/server'
import { AFFILIATE_SWEEP_BATCH_LIMIT } from '@/lib/affiliate/constants'
import { notifyAffiliateOfCommission } from '@/lib/affiliate/notify'

/**
 * POST /api/internal/affiliate/reconcile-refunds -- an unpaid commission
 * (pending/held/approved/payout_queued) whose underlying payment later
 * shows refunded/partially_refunded/chargeback is voided automatically.
 * A commission that was already PAID before the refund is never
 * touched here -- it becomes the "paid commission followed by refund"
 * exception instead (computed live by exceptions-service.ts), requiring
 * admin review before any recovery, exactly as specified.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal affiliate reconciliation endpoint is not configured' }, { status: 503 })
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
      .select('id, payment_id, status, payments(status)')
      .in('status', ['pending', 'held', 'approved', 'payout_queued'])
      .limit(AFFILIATE_SWEEP_BATCH_LIMIT)

    if (selectError) {
      console.error('[internal.affiliate.reconcile-refunds] select error', selectError)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }

    let voidedCount = 0
    for (const row of candidates ?? []) {
      const paymentStatus = (row.payments as unknown as { status: string } | null)?.status
      if (!paymentStatus || !['refunded', 'partially_refunded', 'chargeback'].includes(paymentStatus)) continue

      const { error: voidError } = await admin.rpc('void_affiliate_commission', {
        p_actor_type: 'system',
        p_actor_id: null,
        p_commission_id: row.id,
        p_reason: `underlying payment is now ${paymentStatus}`,
      })
      if (voidError) {
        console.error('[internal.affiliate.reconcile-refunds] void error', { commissionId: row.id, voidError })
        continue
      }
      voidedCount++
      try {
        await notifyAffiliateOfCommission(admin, row.id, 'affiliate.commission_voided', 'affiliate-commission-voided', {
          voidReason: `the underlying payment is now ${paymentStatus}`,
        })
      } catch (emailErr) {
        console.error('[internal.affiliate.reconcile-refunds] email dispatch failed', { commissionId: row.id, emailErr })
      }
    }

    return NextResponse.json({ considered: (candidates ?? []).length, voided: voidedCount })
  } catch (err) {
    console.error('[internal.affiliate.reconcile-refunds] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
