import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { bookingConditionEvidenceRegisterSchema } from '@/lib/bookings/validation'
import { computeRegisterBookingConditionEvidenceHash, checkIdempotentReplay } from '@/lib/bookings/idempotency'
import { canUploadConditionEvidence } from '@/lib/bookings/evidence-eligibility'
import { cleanupUnregisteredUpload } from '@/lib/storage-cleanup'

interface RouteParams {
  params: Promise<{ id: string }>
}

const UUID_RE = /^[0-9a-f-]{36}$/i

/**
 * POST /api/bookings/[id]/evidence -- registers an already-uploaded
 * file as a booking_condition_evidence row. Mirrors
 * src/app/api/rent-to-buy/agreements/[id]/evidence/route.ts's
 * re-validation pattern exactly (client uploads directly to the
 * existing private `rental-media` bucket under its own existing RLS
 * first, this route re-validates the path prefix and the booking's
 * current lifecycle state, then registers the row) -- the genuinely
 * real evidence architecture this phase builds, replacing the fake
 * src/components/trust/media-upload.tsx setTimeout-only "success."
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: bookingId } = await params
  if (!UUID_RE.test(bookingId)) {
    return NextResponse.json({ error: 'Invalid booking id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  const rate = await checkRateLimit(`bookings:evidence:${getClientKey(request)}`, 30, 60_000)
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

  const parsed = bookingConditionEvidenceRegisterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid evidence', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  // Path-prefix re-validation -- the real security check preventing a
  // client from registering a path it didn't actually upload to.
  // rental-media's own storage RLS additionally enforces this same
  // shape at upload time (storage.foldername(name)[2] = auth.uid()) --
  // this is independent, defense-in-depth re-verification, not the
  // only check.
  const expectedPrefix = `${bookingId}/${requester.userId}/`
  if (!parsed.data.storage_path.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: 'Evidence file does not belong to the caller' }, { status: 403 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    // From here on, storage_path has already been proven to belong to
    // the authenticated caller and to this route's bookingId (the
    // prefix check above) -- safe for best-effort cleanup on failure.
    const cleanup = () => cleanupUnregisteredUpload({
      admin, bucket: 'rental-media', storagePath: parsed.data.storage_path,
      metadataTable: 'booking_condition_evidence', metadataPathColumn: 'storage_path', domain: 'booking-condition-evidence',
    })

    if (parsed.data.idempotency_key) {
      const hash = computeRegisterBookingConditionEvidenceHash(bookingId, parsed.data.storage_path, parsed.data.file_type, parsed.data.evidence_stage)
      const replay = await checkIdempotentReplay(admin, requester.userId, 'register_booking_condition_evidence', parsed.data.idempotency_key, hash)
      if (replay.status === 'replay') return NextResponse.json(replay.result, { status: 201 })
      if (replay.status === 'conflict') {
        await cleanup()
        return NextResponse.json({ error: 'This request was already submitted with different data. Please refresh and try again.' }, { status: 409 })
      }
    }

    const { data: booking } = await admin.from('bookings').select('id, renter_id, merchant_id, status').eq('id', bookingId).maybeSingle()
    if (!booking) {
      await cleanup()
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
    }
    if (booking.renter_id !== requester.userId && booking.merchant_id !== requester.userId) {
      await cleanup()
      return NextResponse.json({ error: 'You are not a party to this booking' }, { status: 403 })
    }
    if (!canUploadConditionEvidence(booking.status, parsed.data.evidence_stage)) {
      await cleanup()
      return NextResponse.json({ error: `This booking is not currently eligible for ${parsed.data.evidence_stage === 'pre_handover' ? 'pre-handover' : 'post-return'} evidence` }, { status: 409 })
    }

    const { data: row, error: insertError } = await admin
      .from('booking_condition_evidence')
      .insert({
        booking_id: bookingId,
        uploaded_by: requester.userId,
        evidence_stage: parsed.data.evidence_stage,
        storage_path: parsed.data.storage_path,
        file_type: parsed.data.file_type,
        caption: parsed.data.caption ?? null,
        display_order: parsed.data.display_order ?? 0,
      })
      .select('*')
      .single()

    if (insertError) {
      console.error('[bookings.evidence] insert error', { userId: requester.userId, bookingId, error: insertError })
      await cleanup()
      return NextResponse.json({ error: 'Could not register this evidence file' }, { status: 500 })
    }

    if (parsed.data.idempotency_key) {
      const hash = computeRegisterBookingConditionEvidenceHash(bookingId, parsed.data.storage_path, parsed.data.file_type, parsed.data.evidence_stage)
      await admin.from('idempotency_keys').insert({
        merchant_id: requester.userId,
        operation: 'register_booking_condition_evidence',
        idempotency_key: parsed.data.idempotency_key,
        request_hash: hash,
        result: row,
      })
    }

    return NextResponse.json(row, { status: 201 })
  } catch (err) {
    console.error('[bookings.evidence] unexpected error', { userId: requester.userId, bookingId, err })
    // Everything inside the try block above runs strictly after the
    // path-ownership check, so storage_path is safe to attempt cleanup
    // on here too -- a fresh service-role client (construction only, no
    // network call) since the one created inside the try block is out
    // of scope at this point.
    try {
      const { createClient: createServiceClient } = await import('@supabase/supabase-js')
      await cleanupUnregisteredUpload({
        admin: createServiceClient(url, serviceKey), bucket: 'rental-media', storagePath: parsed.data.storage_path,
        metadataTable: 'booking_condition_evidence', metadataPathColumn: 'storage_path', domain: 'booking-condition-evidence',
      })
    } catch { /* best-effort -- never let cleanup mask the original error below */ }
    return NextResponse.json({ error: 'Could not register this evidence file — please try again' }, { status: 500 })
  }
}

/**
 * GET /api/bookings/[id]/evidence -- lists condition-evidence metadata
 * (never a signed URL; see [evidenceId]/access/route.ts for that) for a
 * booking. Authorization is delegated to booking_condition_evidence's
 * own RLS via the authenticated caller's cookie-bound client -- never
 * re-implemented here.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: bookingId } = await params
  if (!UUID_RE.test(bookingId)) {
    return NextResponse.json({ error: 'Invalid booking id' }, { status: 400 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const asUser = await createClient()
  if (!asUser) {
    return NextResponse.json({ error: 'Booking storage is not configured' }, { status: 503 })
  }

  const { data, error } = await asUser
    .from('booking_condition_evidence')
    .select('id, booking_id, uploaded_by, evidence_stage, file_type, caption, display_order, created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[bookings.evidence.list] error', { userId: requester.userId, bookingId, error })
    return NextResponse.json({ error: 'Could not load evidence' }, { status: 500 })
  }

  return NextResponse.json({ evidence: data ?? [] })
}
