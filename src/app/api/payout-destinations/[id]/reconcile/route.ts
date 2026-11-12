import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/require-admin'
import { reconcileBankVerification } from '@/lib/payments/payout-destinations/service'
import { PayoutDestinationError } from '@/lib/payments/payout-destinations/errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/payout-destinations/[id]/reconcile -- E34: the user-facing
 * "Check verification status" action (phase brief §24). Mirrors
 * /api/admin/payout-destinations/[id]/reconcile exactly, with an
 * ownership check instead of admin authority -- the client never
 * supplies or trusts a status itself, this always queries Peach
 * server-side via the already-known provider_verification_id.
 */
export async function POST(_request: Request, { params }: RouteParams) {
  const requester = await requireAuth()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { id: destinationId } = await params

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data: destination, error: destError } = await admin.from('payout_destinations').select('id, owner_id').eq('id', destinationId).maybeSingle()
  if (destError) {
    console.error('[payout-destinations.reconcile] lookup error', { userId: requester.userId, destError })
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
  if (!destination || destination.owner_id !== requester.userId) {
    return NextResponse.json({ error: 'Payout destination not found' }, { status: 404 })
  }

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
    console.error('[payout-destinations.reconcile] attempt lookup error', { userId: requester.userId, attemptError })
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
    console.error('[payout-destinations.reconcile] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}
