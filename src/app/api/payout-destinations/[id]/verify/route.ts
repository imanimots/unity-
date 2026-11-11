import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/require-admin'
import { submitBankVerification } from '@/lib/payments/payout-destinations/service'
import { mapPayoutDestinationErrorResponse } from '../../route'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/payout-destinations/[id]/verify -- owner-triggered bank
 * account verification submission. Ownership is checked here (not
 * trusted from the path alone) before the service layer ever touches
 * the destination -- the service functions are server-only and take
 * ownership as already-established, same convention as every other
 * admin/self-service orchestrator route in this codebase.
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
    console.error('[payout-destinations.verify] lookup error', { userId: requester.userId, destError })
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
  if (!destination || destination.owner_id !== requester.userId) {
    return NextResponse.json({ error: 'Payout destination not found' }, { status: 404 })
  }

  try {
    // 'initial' vs 'reverification' is audit-trail detail only -- it
    // never changes gating logic in start_bank_verification_attempt --
    // so this route does not distinguish a first submission from a
    // retry; both pass 'initial'.
    const result = await submitBankVerification({ admin }, { destinationId, trigger: 'initial', actorId: requester.userId, actorType: 'owner' })
    return NextResponse.json({ attempt: result })
  } catch (err) {
    return mapPayoutDestinationErrorResponse(err, 'payout-destinations.verify', requester.userId)
  }
}
