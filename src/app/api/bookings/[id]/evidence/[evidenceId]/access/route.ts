import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { getBookingConditionEvidenceSignedUrl } from '@/lib/bookings/evidence-access'

interface RouteParams {
  params: Promise<{ id: string; evidenceId: string }>
}

const UUID_RE = /^[0-9a-f-]{36}$/i

/**
 * POST /api/bookings/[id]/evidence/[evidenceId]/access -- the only way
 * to view/download a booking condition-evidence file. Mirrors
 * /api/rent-to-buy/agreements/[id]/evidence/[evidenceId]/access and
 * /api/disputes/[id]/evidence/[evidenceId]/access exactly. Never
 * returns a permanent URL; the signed URL expires in 120s
 * (src/lib/bookings/evidence-access.ts) and is never stored.
 *
 * Authorization is delegated to booking_condition_evidence's own
 * existing RLS (parties + admin) via a cookie-bound client -- never
 * re-implemented here.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: bookingId, evidenceId } = await params
  if (!UUID_RE.test(bookingId) || !UUID_RE.test(evidenceId)) {
    return NextResponse.json({ error: 'Invalid booking or evidence id' }, { status: 400 })
  }

  const rate = await checkRateLimit(`bookings:evidence:access:${getClientKey(request)}`, 30, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  const asUser = await createClient()
  if (!asUser) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const result = await getBookingConditionEvidenceSignedUrl(asUser, admin, bookingId, evidenceId)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'evidence_not_found') {
      return NextResponse.json({ error: 'Evidence not found for this booking' }, { status: 404 })
    }
    console.error('[bookings.evidence.access] error', { userId: requester.userId, bookingId, evidenceId, err })
    return NextResponse.json({ error: 'Could not generate a secure evidence link' }, { status: 500 })
  }
}
