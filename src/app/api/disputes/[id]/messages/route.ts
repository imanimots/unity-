import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { disputeMessageSchema } from '@/lib/disputes/validation'
import { listMessages, sendMessage } from '@/lib/messaging/service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET/POST /api/disputes/[id]/messages -- Step 11 Phase 3 rewrites this
 * as a thin wrapper over src/lib/messaging/service.ts's shared
 * list/send functions (the same ones GET/POST /api/messages uses),
 * rather than duplicating the query/insert logic that used to live here
 * directly. Kept live (not deleted) through this phase for easy
 * rollback -- actual removal is deferred to a later cleanup commit.
 *
 * Behavior note: this now returns the underlying transaction's FULL
 * message thread, not just messages tagged with this specific
 * dispute_id -- see src/lib/messaging/service.ts's module comment for
 * why ("one messaging model" means a dispute's chat panel is the same
 * thread as the transaction's general chat, not a second thread).
 * Sending through this route still tags new messages with this
 * dispute_id, exactly as before.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const session = await createClient()
  if (!session) {
    return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  }

  const result = await listMessages(session, { disputeId, limit: 100 })
  if (!result.ok) {
    if (result.status === 404) return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    console.error('[disputes.messages.list] error', { userId: requester.userId, disputeId, error: result.error })
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ messages: result.messages })
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const rate = checkRateLimit(`disputes:message:${getClientKey(request)}`, 30, 60_000)
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

  const parsed = disputeMessageSchema.safeParse(body)
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

  const senderName = requester.profile.display_name || requester.profile.full_name || 'Unity user'

  const result = await sendMessage(session, admin, requester.userId, senderName, {
    disputeId,
    content: parsed.data.content,
  })

  if (!result.ok) {
    if (result.status === 404) return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    console.error('[disputes.messages.send] error', { userId: requester.userId, disputeId, error: result.error })
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json(result.message, { status: 201 })
}
