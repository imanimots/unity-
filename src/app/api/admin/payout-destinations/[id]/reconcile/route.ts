import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { reconcileBankVerification } from '@/lib/payments/payout-destinations/service'
import { PayoutDestinationError } from '@/lib/payments/payout-destinations/errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/payout-destinations/[id]/reconcile -- admin-triggered
 * query-based BANV reconciliation (phase brief §53): for a missed/
 * delayed webhook, or a pending attempt that's gone stale. Reconciles
 * against the destination's latest attempt that has a known
 * provider_verification_id but no final result yet -- never submits a
 * new BANV request.
 */
export async function POST(_request: Request, { params }: RouteParams) {
  const admin_requester = await requireAdmin()
  if (!admin_requester) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id: destinationId } = await params

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data: attempt, error: attemptError } = await admin
    .from('payout_destination_verification_attempts')
    .select('id, provider_verification_id')
    .eq('destination_id', destinationId)
    .not('provider_verification_id', 'is', null)
    .is('resolved_at', null)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (attemptError) {
    console.error('[admin.payout-destinations.reconcile] lookup error', { adminId: admin_requester.userId, attemptError })
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
  if (!attempt || !attempt.provider_verification_id) {
    return NextResponse.json({ error: 'No pending verification attempt with a known provider reference for this destination' }, { status: 404 })
  }

  try {
    const result = await reconcileBankVerification({ admin }, { providerVerificationId: attempt.provider_verification_id })
    return NextResponse.json({ result })
  } catch (err) {
    if (err instanceof PayoutDestinationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 502 })
    }
    console.error('[admin.payout-destinations.reconcile] unexpected error', { adminId: admin_requester.userId, err })
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}
