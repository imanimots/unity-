import { NextRequest, NextResponse } from 'next/server'
import { reconcileCommissionDisputes, reconcileCommissionRefunds } from '@/lib/commissions/reconcile'

/**
 * POST /api/internal/commissions/reconcile-refunds -- Rule 7/8/9's
 * refund-driven reconciliation (full refund -> void, partial refund ->
 * proportional adjustment) plus dispute hold/release, in one bounded
 * sweep. Cancellations (Rule 8) are not a separate mechanism here --
 * cancel_order()/cancel_booking() never move money themselves (confirmed
 * live, Phase 2 Step A), so a cancellation only ever changes what a
 * merchant retains once an actual refund is processed, which this same
 * sweep already reconciles.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal commission reconciliation endpoint is not configured' }, { status: 503 })
  }
  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Commission storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const disputeResult = await reconcileCommissionDisputes(admin)
    const refundResult = await reconcileCommissionRefunds(admin)

    return NextResponse.json({
      disputesHeld: disputeResult.held,
      disputesReleased: disputeResult.released,
      disputesScanned: disputeResult.scanned,
      disputesFailed: disputeResult.failed,
      refundsConsidered: refundResult.considered,
      refundsScanned: refundResult.scanned,
      refundsFailed: refundResult.failed,
      voided: refundResult.voided,
      adjusted: refundResult.adjusted,
    })
  } catch (err) {
    console.error('[internal.commissions.reconcile-refunds] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
