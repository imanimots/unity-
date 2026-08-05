import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { MAX_OFFER_MEDIA_COUNT } from '@/lib/barter/offer-media'

interface RouteParams {
  params: Promise<{ id: string }>
}

const registerMediaSchema = z.object({
  offer_id: z.string().uuid(),
  storage_path: z.string().min(1).max(500),
  media_type: z.enum(['photo', 'video']),
  display_order: z.number().int().min(0).max(100).optional(),
})

/**
 * POST /api/barter/[id]/media -- registers a barter_offer_media row after
 * the client has already uploaded the file directly to the
 * barter-offer-media bucket (client-side, RLS-protected upload -- see
 * src/lib/barter/offer-media.ts, mirroring how listing photos upload).
 * A server-side insert is still required because barter_offer_media has
 * no client INSERT policy (20260810000004_barter_offer_media.sql) --
 * evidence media is only ever registered after this route re-validates
 * agreement membership and that the offer is still the current, pending
 * one, not after any arbitrary client-supplied claim.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(agreementId)) {
    return NextResponse.json({ error: 'Invalid barter agreement id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`barter:media:${getClientKey(request)}`, 30, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = registerMediaSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const expectedPrefix = `${agreementId}/${parsed.data.offer_id}/${requester.userId}/`
  if (!parsed.data.storage_path.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: 'Storage path does not match the expected upload location' }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data: agreement } = await admin
      .from('barter_agreements')
      .select('id, party_a_id, party_b_id')
      .eq('id', agreementId)
      .maybeSingle()

    if (!agreement || (agreement.party_a_id !== requester.userId && agreement.party_b_id !== requester.userId)) {
      return NextResponse.json({ error: 'Barter agreement not found' }, { status: 404 })
    }

    const { data: offer } = await admin
      .from('barter_offers')
      .select('id, status, agreement_id')
      .eq('id', parsed.data.offer_id)
      .maybeSingle()

    if (!offer || offer.agreement_id !== agreementId) {
      return NextResponse.json({ error: 'Offer not found' }, { status: 404 })
    }
    if (offer.status !== 'pending') {
      return NextResponse.json({ error: 'Evidence media can only be added to the current, pending offer' }, { status: 409 })
    }

    const { count } = await admin
      .from('barter_offer_media')
      .select('id', { count: 'exact', head: true })
      .eq('offer_id', parsed.data.offer_id)

    if ((count ?? 0) >= MAX_OFFER_MEDIA_COUNT) {
      return NextResponse.json({ error: `A maximum of ${MAX_OFFER_MEDIA_COUNT} media files is allowed per offer` }, { status: 422 })
    }

    const { data, error } = await admin
      .from('barter_offer_media')
      .insert({
        offer_id: parsed.data.offer_id,
        uploaded_by: requester.userId,
        storage_path: parsed.data.storage_path,
        media_type: parsed.data.media_type,
        display_order: parsed.data.display_order ?? 0,
      })
      .select('*')
      .single()

    if (error) {
      console.error('[barter.media] insert error', { userId: requester.userId, agreementId, error })
      return NextResponse.json({ error: 'Could not register the uploaded file' }, { status: 500 })
    }

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    console.error('[barter.media] unexpected error', { userId: requester.userId, agreementId, err })
    return NextResponse.json({ error: 'Could not register the uploaded file — please try again' }, { status: 500 })
  }
}
