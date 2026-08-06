import { NextResponse } from 'next/server'

/**
 * Removed in Step 11 Phase 7 -- superseded entirely by
 * POST /api/affiliate/attribution (persisted at listing-view time) and
 * automatic qualification hooked into the payment success paths. The
 * old implementation trusted a client-supplied `rentalFee` amount
 * directly (a forgeable amount), had no idempotency, never recorded
 * who the referred customer was, and was never called from any real
 * checkout path. Kept as an explicit 410 for one release rather than a
 * bare 404, so any stale client reference fails loud and clear.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'This endpoint has been removed. Affiliate commission is now qualified automatically from successful payments.' },
    { status: 410 }
  )
}
