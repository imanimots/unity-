import { NextRequest, NextResponse } from 'next/server'
import { AFFILIATE_COMMISSION_REVIEW_HOURS, AFFILIATE_SWEEP_BATCH_LIMIT } from '@/lib/affiliate/constants'
import { notifyAffiliateOfCommission } from '@/lib/affiliate/notify'
import { hasCronAuthConfigured, isAuthorizedCronRequest } from '@/lib/internal-cron/auth'

/**
 * GET|POST /api/internal/affiliate/review-and-approve -- first step of
 * the affiliate automation chain (review-and-approve -> queue-payouts ->
 * process-payouts), scheduled via vercel.json (P4). Selects a bounded
 * batch of `pending` commissions older than the review window and calls
 * progress_affiliate_commission() once per row -- the RPC itself decides
 * approved vs. held (blocking refund/dispute found). Idempotent: a
 * commission already progressed past `pending` is simply not in the
 * next sweep's batch. GET (Vercel Cron) and POST (manual/curl) share one
 * handler and the shared isAuthorizedCronRequest() authority
 * (src/lib/internal-cron/auth.ts).
 */
async function handleCronRequest(request: NextRequest) {
  if (!hasCronAuthConfigured()) {
    return NextResponse.json({ error: 'Internal affiliate review endpoint is not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request)) {
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

    const threshold = new Date(Date.now() - AFFILIATE_COMMISSION_REVIEW_HOURS * 60 * 60 * 1000).toISOString()
    const { data: candidates, error: selectError } = await admin
      .from('affiliate_commissions')
      .select('id')
      .eq('status', 'pending')
      .lt('created_at', threshold)
      .limit(AFFILIATE_SWEEP_BATCH_LIMIT)

    if (selectError) {
      console.error('[internal.affiliate.review-and-approve] select error', selectError)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }

    let approvedCount = 0
    let heldCount = 0
    for (const row of candidates ?? []) {
      const { data, error } = await admin.rpc('progress_affiliate_commission', { p_commission_id: row.id })
      if (error) {
        console.error('[internal.affiliate.review-and-approve] progress error', { commissionId: row.id, error })
        continue
      }
      if (data?.status === 'approved') {
        approvedCount++
        try {
          await notifyAffiliateOfCommission(admin, row.id, 'affiliate.commission_approved', 'affiliate-commission-approved')
        } catch (emailErr) {
          console.error('[internal.affiliate.review-and-approve] email dispatch failed', { commissionId: row.id, emailErr })
        }
      } else if (data?.status === 'held') {
        heldCount++
        try {
          await notifyAffiliateOfCommission(admin, row.id, 'affiliate.commission_held', 'affiliate-commission-held')
        } catch (emailErr) {
          console.error('[internal.affiliate.review-and-approve] email dispatch failed', { commissionId: row.id, emailErr })
        }
      }
    }

    return NextResponse.json({ considered: (candidates ?? []).length, approved: approvedCount, held: heldCount })
  } catch (err) {
    console.error('[internal.affiliate.review-and-approve] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handleCronRequest(request)
}

export async function POST(request: NextRequest) {
  return handleCronRequest(request)
}
