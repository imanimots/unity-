import { NextRequest, NextResponse } from 'next/server'
import { createMerchantPayout } from '@/lib/payments/orchestrator'
import { notifyMerchantPayoutEvent } from '@/lib/payouts/notify'

const RECONCILE_MISSING_BATCH_LIMIT = 50

/**
 * POST /api/internal/payouts/reconcile-missing -- secret-authenticated
 * recovery path (Step 11 Phase 8, review correction 2). Because payout
 * creation at booking completion (confirm-return route) is best-effort,
 * a transient failure there can leave a completed booking with a
 * captured rental payment and no merchant_payouts row. This sweep finds
 * exactly those bookings and calls the SAME authoritative creation
 * service used at confirm-return -- never a reimplementation, never a
 * client-supplied amount. Bounded batch, safely re-runnable: a booking
 * that already has a payout row (any status, matching the fixed
 * duplicate guard in create-merchant-payout.ts) is never touched again.
 * Creates at most one payout per booking. No provider is ever called.
 *
 * Candidate discovery (Wave 2C -- payout query scalability): previously
 * fetched EVERY historical merchant_payouts.booking_id into memory and
 * embedded the full list in a `.not('id', 'in', <list>)` PostgREST
 * filter -- the resulting request URL/headers overflowed PostgREST's
 * size limit once payout history grew large enough (confirmed live at
 * ~409 rows). Now delegates the exclusion entirely to
 * _payout_reconcile_missing_candidates(), a single bounded, indexed,
 * server-side NOT EXISTS anti-join (see migration
 * 20260904000004_payout_query_scalability.sql) -- no client-collected ID
 * list of any size ever crosses the wire. No offset/keyset pagination
 * state is needed: a booking that gets a payout (from this batch or from
 * best-effort creation elsewhere) simply falls out of the candidate set
 * on the next call.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal payout reconciliation endpoint is not configured' }, { status: 503 })
  }
  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) {
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

    const { data: candidates, error: selectError } = await admin.rpc('_payout_reconcile_missing_candidates', { p_limit: RECONCILE_MISSING_BATCH_LIMIT })

    if (selectError) {
      console.error('[internal.payouts.reconcile-missing] select error', selectError)
      return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
    }
    const completedBookings = (candidates ?? []).map((row: { booking_id: string }) => ({ id: row.booking_id }))

    let consideredCount = 0
    let createdCount = 0
    let skippedCount = 0

    for (const booking of completedBookings) {
      const { data: capturedRental } = await admin
        .from('payments')
        .select('id')
        .eq('booking_id', booking.id)
        .eq('payment_type', 'rental_charge')
        .eq('status', 'captured')
        .maybeSingle()
      if (!capturedRental) continue

      consideredCount++
      try {
        const payout = await createMerchantPayout({ admin }, booking.id, `reconcile-missing-${booking.id}`)
        createdCount++
        try {
          await notifyMerchantPayoutEvent(admin, payout.payoutId, 'merchant_payout.created')
        } catch (emailErr) {
          console.error('[internal.payouts.reconcile-missing] email dispatch failed', { bookingId: booking.id, payoutId: payout.payoutId, emailErr })
        }
      } catch (createErr) {
        skippedCount++
        console.error('[internal.payouts.reconcile-missing] creation failed', { bookingId: booking.id, createErr })
      }
    }

    return NextResponse.json({ scanned: completedBookings.length, considered: consideredCount, created: createdCount, skipped: skippedCount })
  } catch (err) {
    console.error('[internal.payouts.reconcile-missing] unexpected error', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
