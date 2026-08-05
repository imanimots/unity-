import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { sendMessageSchema, listMessagesQuerySchema } from '@/lib/messaging/validation'
import { sendMessage, listMessages } from '@/lib/messaging/service'
import { computeSendMessageHash, checkIdempotentReplay } from '@/lib/messaging/idempotency'

/**
 * GET/POST /api/messages -- the one real messaging implementation
 * (Step 11 Phase 3). src/app/api/disputes/[id]/messages/route.ts is a
 * thin wrapper over the same src/lib/messaging/service.ts functions,
 * not a duplicate.
 */
export async function GET(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const url = new URL(request.url)
  const parsed = listMessagesQuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const session = await createClient()
  if (!session) {
    return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  }

  const result = await listMessages(session, {
    bookingId: parsed.data.booking_id,
    orderId: parsed.data.order_id,
    barterAgreementId: parsed.data.barter_agreement_id,
    disputeId: parsed.data.dispute_id,
    before: parsed.data.before,
    limit: parsed.data.limit,
  })

  if (!result.ok) {
    if (result.status === 404) return NextResponse.json({ error: result.error }, { status: 404 })
    console.error('[messages.list] error', { userId: requester.userId, error: result.error })
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ messages: result.messages })
}

export async function POST(request: NextRequest) {
  const rate = checkRateLimit(`messages:send:${getClientKey(request)}`, 30, 60_000)
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

  const parsed = sendMessageSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid message', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const session = await createClient()
  if (!session) {
    return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const threadType = parsed.data.booking_id ? 'booking' : parsed.data.order_id ? 'order' : parsed.data.barter_agreement_id ? 'barter' : 'dispute'
  const threadId = parsed.data.booking_id ?? parsed.data.order_id ?? parsed.data.barter_agreement_id ?? parsed.data.dispute_id ?? ''

  if (parsed.data.idempotency_key) {
    const hash = computeSendMessageHash(threadType, threadId, parsed.data.dispute_id, parsed.data.content)
    const replay = await checkIdempotentReplay(admin, requester.userId, 'send_message', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
    if (replay.status === 'conflict') {
      return NextResponse.json({ error: 'This request was already submitted with different data. Please refresh and try again.' }, { status: 409 })
    }
  }

  const senderName = requester.profile.display_name || requester.profile.full_name || 'Unity user'

  const result = await sendMessage(session, admin, requester.userId, senderName, {
    bookingId: parsed.data.booking_id,
    orderId: parsed.data.order_id,
    barterAgreementId: parsed.data.barter_agreement_id,
    disputeId: parsed.data.dispute_id,
    content: parsed.data.content,
  })

  if (!result.ok) {
    if (result.status !== 404) {
      console.error('[messages.send] error', { userId: requester.userId, error: result.error })
    }
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  if (parsed.data.idempotency_key) {
    const hash = computeSendMessageHash(threadType, threadId, parsed.data.dispute_id, parsed.data.content)
    await admin.from('idempotency_keys').insert({
      merchant_id: requester.userId,
      operation: 'send_message',
      idempotency_key: parsed.data.idempotency_key,
      request_hash: hash,
      result: result.message,
    })
  }

  return NextResponse.json(result.message, { status: 201 })
}
