import { NextRequest, NextResponse } from 'next/server'
import { finalizeEarnedCommissions } from '@/lib/commissions/finalize'

/**
 * POST /api/internal/commissions/finalize-earned -- promotes pending
 * commissions past the review window (with no refund/dispute found) to
 * 'earned'. Purely a reporting-clarity sweep; commissions in 'pending'
 * already count identically to 'earned' in payout arithmetic (see
 * createMerchantPayout()).
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal commission finalization endpoint is not configured' }, { status: 503 })
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

    const result = await finalizeEarnedCommissions(admin)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[internal.commissions.finalize-earned] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
