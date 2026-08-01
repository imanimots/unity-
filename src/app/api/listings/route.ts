import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { saveDraftRequestSchema } from '@/lib/listings/validation'
import { validatePublicCategoryMetadata, validatePrivateCategoryMetadata } from '@/lib/listings/category-fields'
import { mapListingRpcError } from '@/lib/listings/rpc-errors'
import { blockIfCannotCreate } from '@/lib/admin/account-status'

/**
 * POST /api/listings — create or update a draft listing.
 *
 * This route validates the request and checks the caller is an
 * authenticated merchant, then delegates the actual multi-table write to
 * `save_listing_draft()` (supabase/migrations/20260729000008_listing_wizard_closure.sql,
 * v2 of the function first defined in 20260729000007), called through the
 * CALLER'S OWN authenticated session — not a service-role client — so the
 * RPC's SECURITY DEFINER privilege is used only for the specific
 * cross-table writes it needs, never as a blanket bypass. See
 * docs/LISTING_SCHEMA.md's Phase 2A section for the full field mapping
 * and security-control rationale.
 *
 * `idempotency_key`, when supplied, is forwarded to the RPC verbatim —
 * the RPC itself (not this route) is the actual idempotency boundary,
 * since it's reachable directly and must not trust a client-side-only
 * guard (see 20260729000008's header).
 *
 * Errors returned to the client are always a short, generic message —
 * raw Postgres/Storage errors are logged server-side only, never
 * forwarded (see src/lib/listings/rpc-errors.ts).
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`listings:save:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in to save a listing' }, { status: 401 })
  }
  if (requester.profile.role !== 'merchant' && requester.profile.role !== 'both') {
    return NextResponse.json({ error: 'Only merchant accounts can create listings' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = saveDraftRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid listing data', fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 }
    )
  }
  const { listing_id, listing, requirements, media, category_metadata, private_category_metadata, availability, idempotency_key } = parsed.data

  // A restricted/suspended account may still edit an existing draft
  // (an existing obligation) but not create a brand new listing.
  if (!listing_id) {
    const blocked = blockIfCannotCreate(requester.profile)
    if (blocked) return blocked
  }

  // Media URLs must point into the caller's own storage folder — never
  // trust an arbitrary client-supplied URL. Files are uploaded directly
  // from the browser before this call (src/lib/listings/storage.ts); this
  // is a sanity check that the referenced object actually belongs to this
  // merchant, not a forged path or someone else's file.
  const ownFolderPrefix = `${requester.userId}/`
  const publicMediaPrefix = `${url}/storage/v1/object/public/listing-media/${ownFolderPrefix}`
  for (const item of media ?? []) {
    const belongsToCaller = item.type === 'ownership_proof'
      ? item.url.startsWith(ownFolderPrefix)
      : item.url.startsWith(publicMediaPrefix)
    if (!belongsToCaller) {
      return NextResponse.json({ error: 'One or more uploaded files could not be verified' }, { status: 400 })
    }
  }

  // First layer of category-metadata sanitization (TS-side, matches the
  // wizard's own rendering rules). The RPC applies the authoritative,
  // SQL-side allowlist regardless — this layer exists so an obviously
  // malformed payload never even reaches the database.
  const sanitizedPublicMetadata = validatePublicCategoryMetadata(listing.category ?? '', category_metadata ?? {})
  const sanitizedPrivateMetadata = validatePrivateCategoryMetadata(listing.category ?? '', private_category_metadata ?? {})

  try {
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    if (!supabase) {
      return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
    }

    const { data, error } = await supabase.rpc('save_listing_draft', {
      p_listing_id: listing_id ?? null,
      p_listing: listing,
      p_requirements: requirements ?? {},
      p_media: media ?? [],
      p_category_metadata: sanitizedPublicMetadata,
      p_private_category_metadata: sanitizedPrivateMetadata,
      p_availability: availability ?? [],
      p_idempotency_key: idempotency_key ?? null,
    })

    if (error) {
      console.error('[listings.save_draft] RPC error', { userId: requester.userId, error })
      const mapped = mapListingRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json({ listing_id: data, status: 'draft' })
  } catch (err) {
    console.error('[listings.save_draft] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not save your listing — please try again' }, { status: 500 })
  }
}
