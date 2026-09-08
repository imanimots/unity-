import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { getMessageAttachmentSignedUrl } from '@/lib/messaging/attachment-access'

interface RouteParams {
  params: Promise<{ id: string; attachmentId: string }>
}

const UUID_RE = /^[0-9a-f-]{36}$/i

/**
 * POST /api/messages/[id]/attachments/[attachmentId]/access -- the only
 * way to view/download a chat attachment. Mirrors
 * /api/disputes/[id]/evidence/[evidenceId]/access exactly. Never returns
 * a permanent URL; the signed URL expires in 120s
 * (src/lib/messaging/attachment-access.ts) and is never stored.
 *
 * Authorization is delegated to message_attachments' own existing RLS
 * (parties + admin, powered by is_message_participant()) via a
 * cookie-bound client -- never re-implemented here. A caller who is not
 * a party to this message's thread, or who supplies an attachment id
 * belonging to a different message, gets the same 404 as a genuinely
 * missing row.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: messageId, attachmentId } = await params
  if (!UUID_RE.test(messageId) || !UUID_RE.test(attachmentId)) {
    return NextResponse.json({ error: 'Invalid message or attachment id' }, { status: 400 })
  }

  const rate = checkRateLimit(`messages:attachments:access:${getClientKey(request)}`, 30, 60_000)
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
    return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  }

  const asUser = await createClient()
  if (!asUser) {
    return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const result = await getMessageAttachmentSignedUrl(asUser, admin, messageId, attachmentId)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'attachment_not_found') {
      return NextResponse.json({ error: 'Attachment not found for this message' }, { status: 404 })
    }
    console.error('[messages.attachments.access] error', { userId: requester.userId, messageId, attachmentId, err })
    return NextResponse.json({ error: 'Could not generate a secure attachment link' }, { status: 500 })
  }
}
