import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { registerMilestoneEvidenceSchema } from '@/lib/barter/skill-task-validation'
import { checkIdempotentReplay } from '@/lib/bookings/idempotency'

interface RouteParams {
  params: Promise<{ id: string; milestoneId: string }>
}

/**
 * POST /api/barter/[id]/milestones/[milestoneId]/evidence -- registers
 * an already-uploaded file as milestone evidence. Mirrors
 * /api/disputes/[id]/evidence's exact pattern: client uploads directly
 * to the barter-milestone-evidence bucket under RLS first, this route
 * re-validates the path prefix and registers the row directly (no RPC
 * layer, matching dispute_evidence's own precedent).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId, milestoneId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(milestoneId)) {
    return NextResponse.json({ error: 'Invalid milestone id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`barter:milestone:evidence:${getClientKey(request)}`, 30, 60_000)
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

  const parsed = registerMilestoneEvidenceSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid evidence', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const expectedPrefix = `${milestoneId}/${requester.userId}/`
  if (!parsed.data.storage_path.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: 'Evidence file does not belong to the caller' }, { status: 403 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const hash = createHash('md5').update(`${milestoneId}|${parsed.data.storage_path}|${parsed.data.file_type}`).digest('hex')

    if (parsed.data.idempotency_key) {
      const replay = await checkIdempotentReplay(admin, requester.userId, 'register_barter_milestone_evidence', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
      if (replay.status === 'conflict') {
        return NextResponse.json({ error: 'This request was already submitted with different data. Please refresh and try again.' }, { status: 409 })
      }
    }

    const { data: milestone } = await admin
      .from('barter_contribution_milestones')
      .select('id, offer_item_id, status')
      .eq('id', milestoneId)
      .maybeSingle()
    if (!milestone) {
      return NextResponse.json({ error: 'Milestone not found' }, { status: 404 })
    }

    const { data: isParticipant } = await admin.rpc('is_barter_contribution_participant', {
      p_offer_item_id: milestone.offer_item_id,
      p_user_id: requester.userId,
    })
    if (!isParticipant) {
      return NextResponse.json({ error: 'You are not a party to this agreement' }, { status: 403 })
    }

    const { data: agreement } = await admin.from('barter_agreements').select('party_a_id, accepted_offer_id').eq('id', agreementId).maybeSingle()
    const actorRole = agreement?.party_a_id === requester.userId ? 'party_a' : 'party_b'

    // A milestone belonging to a superseded/never-accepted offer version
    // is an inert historical proposal only -- mirrors the same guard
    // the complete/schedule/schedule-confirm RPCs already enforce.
    const { data: offerItem } = await admin.from('barter_offer_items').select('offer_id').eq('id', milestone.offer_item_id).maybeSingle()
    if (!agreement?.accepted_offer_id || offerItem?.offer_id !== agreement.accepted_offer_id) {
      return NextResponse.json({ error: 'This milestone does not belong to the accepted offer' }, { status: 409 })
    }

    const { data: row, error: insertError } = await admin
      .from('barter_milestone_evidence')
      .insert({
        milestone_id: milestoneId,
        uploaded_by: requester.userId,
        storage_path: parsed.data.storage_path,
        file_type: parsed.data.file_type,
        display_order: parsed.data.display_order ?? 0,
      })
      .select('*')
      .single()

    if (insertError) {
      console.error('[barter.milestone.evidence] insert error', { userId: requester.userId, milestoneId, error: insertError })
      return NextResponse.json({ error: 'Could not register this evidence file' }, { status: 500 })
    }

    await admin.from('barter_milestone_history').insert({
      milestone_id: milestoneId,
      agreement_id: agreementId,
      actor_user_id: requester.userId,
      actor_role: actorRole,
      event_type: 'evidence_attached',
      previous_status: milestone.status,
      new_status: milestone.status,
      metadata: { evidence_id: row.id, file_type: parsed.data.file_type },
      idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (parsed.data.idempotency_key) {
      await admin.from('idempotency_keys').insert({
        merchant_id: requester.userId,
        operation: 'register_barter_milestone_evidence',
        idempotency_key: parsed.data.idempotency_key,
        request_hash: hash,
        result: row,
      })
    }

    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    console.error('[barter.milestone.evidence] unexpected error', { userId: requester.userId, milestoneId, err })
    return NextResponse.json({ error: 'Could not register this evidence file — please try again' }, { status: 500 })
  }
}
