import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/supabase/require-admin'
import { disablePayoutDestination } from '@/lib/payments/payout-destinations/service'
import { mapPayoutDestinationErrorResponse } from '../../route'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/payout-destinations/[id]/disable -- E34: wires up E32's
 * existing disablePayoutDestination() service function, which had no
 * route calling it yet. Mirrors the verify route's exact ownership-
 * check pattern. Soft-disable only (sets disabled_at, never deletes --
 * see the E32 migration's own "retention policy must be defined before
 * any deletion" comment, unchanged by this phase).
 */
export async function POST(request: Request, { params }: RouteParams) {
  const requester = await requireAuth()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { id: destinationId } = await params

  const body = await request.json().catch(() => ({}))
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : undefined

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Payout storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data: destination, error: destError } = await admin.from('payout_destinations').select('id, owner_id').eq('id', destinationId).maybeSingle()
  if (destError) {
    console.error('[payout-destinations.disable] lookup error', { userId: requester.userId, destError })
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
  if (!destination || destination.owner_id !== requester.userId) {
    return NextResponse.json({ error: 'Payout destination not found' }, { status: 404 })
  }

  try {
    await disablePayoutDestination({ admin }, { destinationId, actorId: requester.userId, actorType: 'owner', reason })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return mapPayoutDestinationErrorResponse(err, 'payout-destinations.disable', requester.userId)
  }
}
