import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { rentToBuyEvidenceRegisterSchema } from '@/lib/rent-to-buy/validation'
import { computeRegisterRentToBuyEvidenceHash, checkIdempotentReplay } from '@/lib/rent-to-buy/idempotency'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/rent-to-buy/agreements/[id]/evidence -- registers an
 * already-uploaded file as a rent_to_buy_evidence row. Mirrors
 * src/app/api/disputes/[id]/evidence/route.ts's re-validation pattern
 * exactly (client uploads directly to storage under RLS first, this
 * route re-validates the path prefix and registers the row) -- the
 * genuinely real evidence architecture this domain reuses (Rule 5),
 * never the fake booking media-upload stub.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(agreementId)) {
    return NextResponse.json({ error: 'Invalid agreement id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Rent-to-buy storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`rtb:evidence:${getClientKey(request)}`, 30, 60_000)
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

  const parsed = rentToBuyEvidenceRegisterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid evidence', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const expectedPrefix = `${agreementId}/${requester.userId}/`
  if (!parsed.data.storage_path.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: 'Evidence file does not belong to the caller' }, { status: 403 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    if (parsed.data.idempotency_key) {
      const hash = computeRegisterRentToBuyEvidenceHash(agreementId, parsed.data.storage_path, parsed.data.file_type, parsed.data.evidence_type)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'register_rent_to_buy_evidence', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
      if (replay.status === 'conflict') {
        return NextResponse.json({ error: 'This request was already submitted with different data. Please refresh and try again.' }, { status: 409 })
      }
    }

    const { data: agreement } = await admin.from('rent_to_buy_agreements').select('id, merchant_id, customer_id').eq('id', agreementId).maybeSingle()
    if (!agreement) {
      return NextResponse.json({ error: 'Agreement not found' }, { status: 404 })
    }
    if (agreement.merchant_id !== requester.userId && agreement.customer_id !== requester.userId) {
      return NextResponse.json({ error: 'You are not a party to this agreement' }, { status: 403 })
    }
    if (parsed.data.evidence_type === 'pre_handover' && agreement.merchant_id !== requester.userId) {
      return NextResponse.json({ error: 'Only the merchant can upload pre-handover evidence' }, { status: 403 })
    }
    if (parsed.data.evidence_type === 'post_handover_receipt' && agreement.customer_id !== requester.userId) {
      return NextResponse.json({ error: 'Only the customer can upload receipt evidence' }, { status: 403 })
    }

    const { data: row, error: insertError } = await admin
      .from('rent_to_buy_evidence')
      .insert({
        agreement_id: agreementId,
        uploaded_by: requester.userId,
        evidence_type: parsed.data.evidence_type,
        storage_path: parsed.data.storage_path,
        file_type: parsed.data.file_type,
        display_order: parsed.data.display_order ?? 0,
      })
      .select('*')
      .single()

    if (insertError) {
      console.error('[rent-to-buy.evidence] insert error', { userId: requester.userId, agreementId, error: insertError })
      return NextResponse.json({ error: 'Could not register this evidence file' }, { status: 500 })
    }

    if (parsed.data.idempotency_key) {
      const hash = computeRegisterRentToBuyEvidenceHash(agreementId, parsed.data.storage_path, parsed.data.file_type, parsed.data.evidence_type)
      await admin.from('idempotency_keys').insert({
        merchant_id: requester.userId,
        operation: 'register_rent_to_buy_evidence',
        idempotency_key: parsed.data.idempotency_key,
        request_hash: hash,
        result: row,
      })
    }

    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    console.error('[rent-to-buy.evidence] unexpected error', { userId: requester.userId, agreementId, err })
    return NextResponse.json({ error: 'Could not register this evidence file — please try again' }, { status: 500 })
  }
}
