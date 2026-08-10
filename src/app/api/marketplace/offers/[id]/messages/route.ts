import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { filterMessage } from '@/lib/chat-filter'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET/POST /api/marketplace/offers/[id]/messages -- Step Y chat
 * integration. Reuses the existing `messages` table (same Realtime
 * publication, same filterMessage() phone/email/payment-request
 * auto-blocking) via a dedicated thin route rather than widening the
 * generic booking/order/barter thread-resolver -- an offer's thread has
 * no "underlying transaction" the way a dispute's does, and this keeps
 * the touch to the existing, delicate multi-type resolver at zero. Not
 * a parallel messaging system: same table, same RLS
 * ("messages: parties read"/"messages: parties send", widened in
 * 20260826000002 to cover marketplace_offer_id), same filter.
 *
 * Authorization: only the request's requester or the offer's own
 * responder may read/send -- enforced both here (a clean 403/404) and
 * again by RLS at the database level (defense in depth).
 */
async function resolveParticipant(admin: import('@supabase/supabase-js').SupabaseClient, offerId: string, userId: string) {
  const { data: offer } = await admin.from('marketplace_request_offers').select('id, request_id, responder_id').eq('id', offerId).maybeSingle()
  if (!offer) return null
  const { data: req } = await admin.from('marketplace_requests').select('requester_id').eq('id', offer.request_id).maybeSingle()
  if (!req) return null
  if (offer.responder_id !== userId && req.requester_id !== userId) return null
  return offer
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: offerId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(offerId)) return NextResponse.json({ error: 'Invalid offer id' }, { status: 400 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const offer = await resolveParticipant(admin, offerId, requester.userId)
  if (!offer) return NextResponse.json({ error: 'Offer not found' }, { status: 404 })

  const { data, error } = await admin.from('messages').select('*').eq('marketplace_offer_id', offerId).order('created_at', { ascending: true }).limit(200)
  if (error) {
    console.error('[marketplace.offers.messages.list] error', { offerId, error })
    return NextResponse.json({ error: 'Could not load messages' }, { status: 500 })
  }
  return NextResponse.json({ messages: data ?? [] })
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: offerId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(offerId)) return NextResponse.json({ error: 'Invalid offer id' }, { status: 400 })

  const rate = checkRateLimit(`marketplace:offers:message:${getClientKey(request)}`, 30, 60_000)
  if (!rate.allowed) return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const offer = await resolveParticipant(admin, offerId, requester.userId)
  if (!offer) return NextResponse.json({ error: 'Offer not found' }, { status: 404 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const content = (body as { content?: string })?.content?.trim()
  if (!content || content.length === 0 || content.length > 2000) {
    return NextResponse.json({ error: 'Message content is required (max 2000 characters)' }, { status: 400 })
  }

  const { blocked, reason } = filterMessage(content)

  const { data, error } = await admin
    .from('messages')
    .insert({ marketplace_offer_id: offerId, sender_id: requester.userId, content, is_filtered: blocked, filter_reason: reason })
    .select('*')
    .single()

  if (error) {
    console.error('[marketplace.offers.messages.send] error', { offerId, error })
    return NextResponse.json({ error: 'Could not send message' }, { status: 500 })
  }
  return NextResponse.json({ message: data }, { status: 201 })
}
