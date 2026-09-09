import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { attachmentRegisterSchema } from '@/lib/messaging/validation'
import { isUnderAttachmentLimit } from '@/lib/messaging/attachments'
import { computeRegisterAttachmentHash, checkIdempotentReplay } from '@/lib/messaging/idempotency'
import { cleanupUnregisteredUpload } from '@/lib/storage-cleanup'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/messages/[id]/attachments -- registers an already-uploaded
 * file as a message_attachments row. Mirrors
 * src/app/api/disputes/[id]/evidence/route.ts's re-validation pattern
 * exactly (client uploads directly to storage under RLS first, this
 * route re-validates and registers the row), with two additions
 * specific to messages: a per-message attachment count cap, and
 * deriving the expected storage path prefix from the message's own
 * thread (booking/order/barter) rather than a fixed id, since
 * attachments are scoped by transaction, not by message_id (the
 * message already exists by the time this route runs, but the object
 * was uploaded before that -- see src/lib/messaging/attachments.ts).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: messageId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(messageId)) {
    return NextResponse.json({ error: 'Invalid message id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Chat storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`messages:attachments:${getClientKey(request)}`, 30, 60_000)
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

  const parsed = attachmentRegisterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid attachment', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeRegisterAttachmentHash(messageId, parsed.data.storage_path, parsed.data.file_type)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'register_message_attachment', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
      if (replay.status === 'conflict') {
        return NextResponse.json({ error: 'This request was already submitted with different data. Please refresh and try again.' }, { status: 409 })
      }
    }

    const { data: message } = await admin
      .from('messages')
      .select('id, booking_id, order_id, barter_agreement_id')
      .eq('id', messageId)
      .maybeSingle()
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const { data: isParticipant } = await admin.rpc('is_message_participant', {
      p_message_id: messageId,
      p_user_id: requester.userId,
    })
    if (!isParticipant) {
      return NextResponse.json({ error: 'You are not a party to this conversation' }, { status: 403 })
    }

    const threadType = message.booking_id ? 'booking' : message.order_id ? 'order' : 'barter'
    const threadId = message.booking_id ?? message.order_id ?? message.barter_agreement_id

    const expectedPrefix = `${threadType}/${threadId}/${requester.userId}/`
    if (!parsed.data.storage_path.startsWith(expectedPrefix)) {
      return NextResponse.json({ error: 'Attachment file does not belong to the caller' }, { status: 403 })
    }

    // Unlike the other three evidence-registration routes, path
    // ownership can only be proven here (above), after the message
    // lookup -- the expected prefix depends on the message's own thread
    // type/id, which isn't known until that lookup runs. So only
    // failures from this point on may attempt cleanup; the
    // message-not-found/not-a-participant/idempotency-conflict branches
    // above this point never had a validated path in scope and must not
    // attempt it (residual scenario, by design).
    const cleanup = () => cleanupUnregisteredUpload({
      admin, bucket: 'chat-attachments', storagePath: parsed.data.storage_path,
      metadataTable: 'message_attachments', metadataPathColumn: 'storage_path', domain: 'chat-attachments',
    })

    const { count } = await admin
      .from('message_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('message_id', messageId)
    if (!isUnderAttachmentLimit(count ?? 0)) {
      await cleanup()
      return NextResponse.json({ error: 'This message already has the maximum number of attachments' }, { status: 409 })
    }

    const { data: row, error: insertError } = await admin
      .from('message_attachments')
      .insert({
        message_id: messageId,
        uploaded_by: requester.userId,
        storage_path: parsed.data.storage_path,
        file_type: parsed.data.file_type,
      })
      .select('*')
      .single()

    if (insertError) {
      if (insertError.code === '23505') {
        // message_attachments has exactly one unique constraint --
        // message_attachments_message_path_uniq on (message_id,
        // storage_path) (20260815000001) -- confirmed both in the
        // migration source and live (a direct insert probe against the
        // dev database: re-inserting the identical (message_id,
        // storage_path) pair raises this exact constraint by name;
        // inserting the same storage_path under a *different*
        // message_id succeeds, proving the constraint is scoped to the
        // pair, not to storage_path alone). This insert supplies
        // exactly (messageId, parsed.data.storage_path) -- the same
        // pair a 23505 here re-uses -- so this violation can only occur
        // if a row with this exact storage_path already exists. No
        // separate cleanup call is needed: cleanupUnregisteredUpload()'s
        // own storage_path existence check would independently reach
        // the same "already registered, never delete" conclusion.
        return NextResponse.json({ error: 'This file has already been attached to this message' }, { status: 409 })
      }
      console.error('[messages.attachments] insert error', { userId: requester.userId, messageId, error: insertError })
      await cleanup()
      return NextResponse.json({ error: 'Could not register this attachment' }, { status: 500 })
    }

    if (parsed.data.idempotency_key) {
      const hash = computeRegisterAttachmentHash(messageId, parsed.data.storage_path, parsed.data.file_type)
      await admin.from('idempotency_keys').insert({
        merchant_id: requester.userId,
        operation: 'register_message_attachment',
        idempotency_key: parsed.data.idempotency_key,
        request_hash: hash,
        result: row,
      })
    }

    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    console.error('[messages.attachments] unexpected error', { userId: requester.userId, messageId, err })
    // Deliberately no cleanup attempt here, unlike the other three
    // evidence-registration routes: this try block spans code that runs
    // both before AND after path ownership is established (the prefix
    // check happens partway through, after the message lookup), so an
    // exception caught here cannot be assumed to have a validated path
    // in scope. Residual orphan scenario -- see the Phase A report.
    return NextResponse.json({ error: 'Could not register this attachment — please try again' }, { status: 500 })
  }
}
