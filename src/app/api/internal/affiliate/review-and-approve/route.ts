import { NextRequest, NextResponse } from 'next/server'
import { AFFILIATE_COMMISSION_REVIEW_HOURS, AFFILIATE_SWEEP_BATCH_LIMIT } from '@/lib/affiliate/constants'
import { notifyAffiliateOfCommission } from '@/lib/affiliate/notify'

/**
 * POST /api/internal/affiliate/review-and-approve -- secret-authenticated,
 * mirrors POST /api/internal/expire-unpaid-bookings' exact shape. Selects
 * a bounded batch of `pending` commissions older than the review window
 * and calls progress_affiliate_commission() once per row -- the RPC
 * itself decides approved vs. held (blocking refund/dispute found).
 * Idempotent: a commission already progressed past `pending` is simply
 * not in the next sweep's batch.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal affiliate review endpoint is not configured' }, { status: 503 })
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
