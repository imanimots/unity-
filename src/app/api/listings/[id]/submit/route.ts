import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { submitRequestSchema } from '@/lib/listings/validation'
import { computeListingCompleteness } from '@/lib/listings/completeness'
import { mapListingRpcError } from '@/lib/listings/rpc-errors'
import { computeSubmitRequestHash } from '@/lib/listings/idempotency'
import { blockIfCannotCreate } from '@/lib/admin/account-status'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/listings/[id]/submit — advance a draft to 'pending' review.
 *
 * Completeness is judged against the listing's actual persisted state
 * (fetched here — listings, listing_media, listing_private_details,
 * listing_requirements, listing_availability), never against whatever the
 * client claims it just saved — see the module comment in
 * src/lib/listings/validation.ts. The completeness check below is the
 * ONLY place completeness is evaluated — it is not duplicated in SQL.
 * `submit_listing_for_review()` (20260730000002_restrict_submit_to_server.sql)
 * is callable only via the service role for exactly this reason: it
 * independently re-checks ownership, draft status, declarations, and
 * idempotency, but a direct RPC call bypassing this route would skip the
 * completeness gate entirely, so the RPC is not reachable that way.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`listings:submit:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to submit a listing' }, { status: 401 })
  }
  if (requester.profile.role !== 'merchant' && requester.profile.role !== 'both') {
    return NextResponse.json({ error: 'Only merchant accounts can submit listings' }, { status: 403 })
  }
  const blocked = blockIfCannotCreate(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = submitRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid submission', fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 }
    )
  }

  try {
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    if (!supabase) {
      return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
    }

    // RLS ("listings: public read active" allows auth.uid() = merchant_id
    // regardless of status) naturally scopes this to the caller's own row.
    const { data: listingRow, error: listingError } = await supabase
      .from('listings')
      .select(`
        id, merchant_id, status, title, category, condition, description, daily_rate,
        min_rental_days, max_rental_days, shipping_payer, condition_confirmed, known_defects,
        replacement_value, quantity_available, province, city, available_from,
        deposit_required, category_metadata
      `)
      .eq('id', listingId)
      .single()

    if (listingError || !listingRow) {
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
    }
    if (listingRow.merchant_id !== requester.userId) {
      return NextResponse.json({ error: 'You do not own this listing' }, { status: 403 })
    }

    // submit_listing_for_review is only executable by the service role (see
    // 20260730000002_restrict_submit_to_server.sql) — direct calls from an
    // authenticated client bypass the completeness check below, which is
    // the single source of truth for listing completeness. p_merchant_id
    // is the already-verified requester.userId, not a client-supplied value.
    // Built here (rather than just before the RPC call) so the same client
    // can also check for an idempotent replay next.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceKey) {
      return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
    }
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    // A genuine retry of an already-completed submission must return the
    // original success, not a 409 — the status check below would otherwise
    // reject it, since the first successful call already moved the listing
    // out of 'draft'. idempotency_keys has zero RLS policies by design (see
    // 20260729000008) — never exposed to the browser directly, only read
    // here via the service-role client, and only the `result` field (never
    // the raw row) is ever returned to the client.
    if (parsed.data.idempotency_key) {
      const { data: existingKey } = await admin
        .from('idempotency_keys')
        .select('request_hash, result')
        .eq('merchant_id', requester.userId)
        .eq('operation', 'submit_listing_for_review')
        .eq('idempotency_key', parsed.data.idempotency_key)
        .maybeSingle()

      if (existingKey) {
        const requestHash = computeSubmitRequestHash(listingId, parsed.data.declaration_types)
        if (existingKey.request_hash !== requestHash) {
          const mapped = mapListingRpcError('idempotency key already used with a different request')
          return NextResponse.json({ error: mapped.error }, { status: mapped.status })
        }
        return NextResponse.json(existingKey.result)
      }
    }

    if (listingRow.status !== 'draft') {
      return NextResponse.json({ error: 'This listing has already been submitted' }, { status: 409 })
    }

    const [{ data: mediaRows }, { data: privateDetails }, { data: requirementsRow }, { data: availabilityRows }] = await Promise.all([
      supabase.from('listing_media').select('type, shot_type').eq('listing_id', listingId),
      supabase.from('listing_private_details').select('private_category_metadata').eq('listing_id', listingId).maybeSingle(),
      supabase.from('listing_requirements').select('requested_deposit_amount, driving_licence_required, licence_class').eq('listing_id', listingId).maybeSingle(),
      supabase.from('listing_availability').select('start_date, end_date').eq('listing_id', listingId),
    ])

    const photos = (mediaRows ?? []).filter((m) => m.type === 'photo')
    const hasOwnershipProof = (mediaRows ?? []).some((m) => m.type === 'ownership_proof')
    const hasPrimaryPhoto = photos.some((m) => m.shot_type === 'primary')
    const hasDamagePhoto = photos.some((m) => m.shot_type === 'damage_closeup')

    const completeness = computeListingCompleteness({
      title: listingRow.title,
      category: listingRow.category,
      condition: listingRow.condition ?? undefined,
      description: listingRow.description ?? undefined,
      daily_rate: listingRow.daily_rate,
      min_rental_days: listingRow.min_rental_days,
      max_rental_days: listingRow.max_rental_days ?? undefined,
      shipping_payer: listingRow.shipping_payer,
      condition_confirmed: listingRow.condition_confirmed,
      known_defects: listingRow.known_defects,
      replacement_value: listingRow.replacement_value ?? undefined,
      quantity_available: listingRow.quantity_available ?? undefined,
      province: listingRow.province,
      city: listingRow.city,
      available_from: listingRow.available_from,
      photoCount: photos.length,
      hasPrimaryPhoto,
      hasDamagePhoto,
      hasOwnershipProof,
      acceptedDeclarationTypes: parsed.data.declaration_types,
      categoryMetadata: (listingRow.category_metadata ?? {}) as Record<string, string | undefined>,
      privateCategoryMetadata: (privateDetails?.private_category_metadata ?? {}) as Record<string, string | undefined>,
      deposit_required: listingRow.deposit_required,
      requested_deposit_amount: requirementsRow?.requested_deposit_amount ?? undefined,
      driving_licence_required: requirementsRow?.driving_licence_required ?? false,
      licence_class: requirementsRow?.licence_class ?? null,
      blockedRanges: availabilityRows ?? undefined,
      merchantAuthenticated: true,
      merchantRole: requester.profile.role,
      merchantKycStatus: requester.profile.kyc_status,
      merchantUnityScore: requester.profile.unity_score,
    })

    if (!completeness.isComplete) {
      return NextResponse.json(
        { error: 'This listing is not ready to submit', completeness },
        { status: 422 }
      )
    }

    const { data, error } = await admin.rpc('submit_listing_for_review', {
      p_listing_id: listingId,
      p_merchant_id: requester.userId,
      p_declaration_types: parsed.data.declaration_types,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[listings.submit] RPC error', { userId: requester.userId, listingId, error })
      const mapped = mapListingRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[listings.submit] unexpected error', { userId: requester.userId, listingId, err })
    return NextResponse.json({ error: 'Could not submit your listing — please try again' }, { status: 500 })
  }
}
