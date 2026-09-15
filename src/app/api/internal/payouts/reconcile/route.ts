import { NextRequest, NextResponse } from 'next/server'
import { listOperationalExceptions } from '@/lib/admin/exceptions-service'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/payouts/reconcile -- READ-ONLY detection sweep.
 * Reuses listOperationalExceptions() (the same live computation the
 * admin exceptions page already runs) rather than duplicating the same
 * detection queries in a second place -- filtered to payout-related
 * categories. Never mutates a payout: no automatic mark-paid, no
 * automatic reversal. Surfaces stalled/mismatched/paid-then-refunded
 * payouts for admin review only.
 *
 * Scheduled via vercel.json (P4) at :10 every 6th hour, deliberately
 * after that same hour's /api/internal/payouts/reconcile-missing run
 * (:05, hourly) -- guarantees this detection sweep never runs before
 * the repair pass has had a chance to close a genuinely-missing payout
 * from earlier that hour. GET (Vercel Cron) and POST (manual/curl)
 * share one handler and the shared isAuthorizedCronRequest() authority
 * (src/lib/internal-cron/auth.ts).
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) {
    return NextResponse.json({ error: 'Internal payout reconciliation endpoint is not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const exceptions = await listOperationalExceptions(admin)
    const payoutExceptions = exceptions.filter((e) => e.type.startsWith('merchant_payout_') && !e.resolved)

    const byType: Record<string, number> = {}
    for (const e of payoutExceptions) {
      byType[e.type] = (byType[e.type] ?? 0) + 1
    }

    return NextResponse.json({ detected: payoutExceptions.length, byType })
  } catch (err) {
    console.error('[internal.payouts.reconcile] unexpected error', err)
    return NextResponse.json({ error: 'Reconciliation sweep failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
