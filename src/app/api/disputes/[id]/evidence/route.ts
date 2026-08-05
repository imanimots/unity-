import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { disputeEvidenceRegisterSchema } from '@/lib/disputes/validation'
import { computeRegisterDisputeEvidenceHash, checkIdempotentReplay } from '@/lib/disputes/idempotency'
import { notifyDisputeParties } from '@/lib/disputes/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/disputes/[id]/evidence -- registers an already-uploaded
 * file as a dispute_evidence row. Mirrors
 * src/app/api/barter/[id]/media/route.ts's re-validation pattern
 * exactly (client uploads directly to storage under RLS first, this
 * route re-validates and registers the row) -- with idempotency added
 * at the route level, which the barter media route didn't have; the
 * brief explicitly asks for it here.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`disputes:evidence:${getClientKey(request)}`, 30, 60_000)
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

  const parsed = disputeEvidenceRegisterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid evidence', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  // Path-prefix re-validation -- the real security check preventing a
  // client from registering a path it didn't actually upload to.
  const expectedPrefix = `${disputeId}/${requester.userId}/`
  if (!parsed.data.storage_path.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: 'Evidence file does not belong to the caller' }, { status: 403 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeRegisterDisputeEvidenceHash(disputeId, parsed.data.storage_path, parsed.data.file_type)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'register_dispute_evidence', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
      if (replay.status === 'conflict') {
        return NextResponse.json({ error: 'This request was already submitted with different data. Please refresh and try again.' }, { status: 409 })
      }
    }

    const { data: dispute } = await admin.from('disputes').select('id, raised_by, status').eq('id', disputeId).maybeSingle()
    if (!dispute) {
      return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
    }
    if (['resolved', 'closed', 'cancelled'].includes(dispute.status)) {
      return NextResponse.json({ error: 'This dispute is no longer active' }, { status: 409 })
    }

    const { data: isParticipant } = await admin.rpc('is_dispute_participant', {
      p_dispute_id: disputeId,
      p_user_id: requester.userId,
    })
    if (!isParticipant) {
      return NextResponse.json({ error: 'You are not a party to this dispute' }, { status: 403 })
    }

    const { data: row, error: insertError } = await admin
      .from('dispute_evidence')
      .insert({
        dispute_id: disputeId,
        uploaded_by: requester.userId,
        storage_path: parsed.data.storage_path,
        file_type: parsed.data.file_type,
        display_order: parsed.data.display_order ?? 0,
      })
      .select('*')
      .single()

    if (insertError) {
      console.error('[disputes.evidence] insert error', { userId: requester.userId, disputeId, error: insertError })
      return NextResponse.json({ error: 'Could not register this evidence file' }, { status: 500 })
    }

    await admin.from('dispute_history').insert({
      dispute_id: disputeId,
      actor_user_id: requester.userId,
      actor_role: requester.userId === dispute.raised_by ? 'raiser' : 'respondent',
      event_type: 'evidence_uploaded',
      previous_status: dispute.status,
      new_status: dispute.status,
      metadata: { evidence_id: row.id, file_type: parsed.data.file_type },
      idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (parsed.data.idempotency_key) {
      const hash = computeRegisterDisputeEvidenceHash(disputeId, parsed.data.storage_path, parsed.data.file_type)
      await admin.from('idempotency_keys').insert({
        merchant_id: requester.userId,
        operation: 'register_dispute_evidence',
        idempotency_key: parsed.data.idempotency_key,
        request_hash: hash,
        result: row,
      })
    }

    try {
      await notifyDisputeParties(admin, disputeId, 'dispute.evidence_received', 'dispute-evidence-received')
    } catch (emailErr) {
      console.error('[disputes.evidence] email dispatch failed', { userId: requester.userId, disputeId, emailErr })
    }

    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    console.error('[disputes.evidence] unexpected error', { userId: requester.userId, disputeId, err })
    return NextResponse.json({ error: 'Could not register this evidence file — please try again' }, { status: 500 })
  }
}
