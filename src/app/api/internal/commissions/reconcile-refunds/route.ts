import { NextRequest, NextResponse } from 'next/server'
import { reconcileCommissionDisputes, reconcileCommissionRefunds } from '@/lib/commissions/reconcile'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/commissions/reconcile-refunds -- Rule 7/8/9's
 * refund-driven reconciliation (full refund -> void, partial refund ->
 * proportional adjustment) plus dispute hold/release, in one bounded
 * sweep, scheduled via vercel.json (P4). Cancellations (Rule 8) are not
 * a separate mechanism here -- cancel_order()/cancel_booking() never
 * move money themselves, so a cancellation only ever changes what a
 * merchant retains once an actual refund is processed, which this same
 * sweep already reconciles. GET (Vercel Cron) and POST (manual/curl)
 * share one handler and the shared isAuthorizedCronRequest() authority
 * (src/lib/internal-cron/auth.ts).
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) {
    return NextResponse.json({ error: 'Internal commission reconciliation endpoint is not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request)) {
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

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
