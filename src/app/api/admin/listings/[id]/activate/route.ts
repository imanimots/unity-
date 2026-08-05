import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { activateSchema } from '@/lib/listings/admin-validation'
import { computeListingCompleteness } from '@/lib/listings/completeness'
import type { CompletenessInput } from '@/lib/listings/completeness'
import { checkActivationEligibility } from '@/lib/listings/activation'
import { getRiskRequirements } from '@/lib/risk/engine'
import type { RiskTier } from '@/lib/risk/engine'
import { activateListing } from '@/lib/listings/moderation-service'
import { mapAdminRpcError } from '@/lib/listings/admin-rpc-errors'
import type { OwnershipVerificationStatus } from '@/lib/ownership-verification'
import { sendTemplate, loadListingEmailContext } from '@/lib/email'
import { blocksNewTransactions } from '@/lib/admin/account-status'
import type { AccountStatus } from '@/types'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/listings/[id]/activate -- the browser never sets
 * status = active. This route runs the full server-authoritative
 * eligibility check (src/lib/listings/activation.ts, reusing
 * computeListingCompleteness -- never duplicated) against the listing's
 * actual persisted state, and only calls activate_listing() if it passes.
 * The RPC itself re-checks the cheap SQL-expressible subset
 * (status + moderation approval) as defense in depth -- see its own
 * comment in 20260803000003_admin_moderation_rpcs.sql -- but this route's
 * check is what's authoritative for completeness/risk-tier requirements.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:listings:activate')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = activateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const { data: listing, error: listingError } = await admin.from('listings').select('*').eq('id', listingId).maybeSingle()
  if (listingError || !listing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
  }

  const [{ data: merchant }, { data: privateDetails }, { data: requirements }, { data: mediaRows }, { data: moderation }, { data: ownership }, { data: declarations }] = await Promise.all([
    admin.from('profiles').select('kyc_status, unity_score, account_status').eq('id', listing.merchant_id).maybeSingle(),
    admin.from('listing_private_details').select('private_category_metadata').eq('listing_id', listingId).maybeSingle(),
    admin.from('listing_requirements').select('requested_deposit_amount, driving_licence_required, licence_class').eq('listing_id', listingId).maybeSingle(),
    admin.from('listing_media').select('type, shot_type').eq('listing_id', listingId),
    admin.from('listing_moderation').select('moderation_status').eq('listing_id', listingId).maybeSingle(),
    admin.from('listing_ownership_verification').select('status').eq('listing_id', listingId).maybeSingle(),
    admin.from('listing_declarations').select('declaration_type, accepted').eq('listing_id', listingId),
  ])

  const photos = (mediaRows ?? []).filter((m) => m.type === 'photo')
  const hasOwnershipProof = (mediaRows ?? []).some((m) => m.type === 'ownership_proof')
  const hasPrimaryPhoto = photos.some((m) => m.shot_type === 'primary')
  const hasDamagePhoto = photos.some((m) => m.shot_type === 'damage_closeup')
  const acceptedDeclarationTypes = (declarations ?? []).filter((d) => d.accepted).map((d) => d.declaration_type)

  const riskTier = (listing.risk_tier as RiskTier) ?? 'low'
  const riskRequirements = getRiskRequirements(riskTier)
  const ownershipStatus: OwnershipVerificationStatus = ownership?.status ?? (riskRequirements.ownershipVerificationRequired ? 'pending' : 'not_required')

  const completenessInput: CompletenessInput = {
    title: listing.title,
    category: listing.category,
    condition: listing.condition ?? undefined,
    description: listing.description ?? undefined,
    listing_type: listing.listing_type ?? 'rental',
    sale_price: listing.sale_price ?? undefined,
    daily_rate: listing.daily_rate,
    min_rental_days: listing.min_rental_days,
    max_rental_days: listing.max_rental_days ?? undefined,
    shipping_payer: listing.shipping_payer,
    condition_confirmed: listing.condition_confirmed,
    known_defects: listing.known_defects,
    replacement_value: listing.replacement_value ?? undefined,
    quantity_available: listing.quantity_available ?? undefined,
    province: listing.province,
    city: listing.city,
    available_from: listing.available_from,
    photoCount: photos.length,
    hasPrimaryPhoto,
    hasDamagePhoto,
    hasOwnershipProof,
    acceptedDeclarationTypes,
    categoryMetadata: (listing.category_metadata ?? {}) as Record<string, string | undefined>,
    privateCategoryMetadata: (privateDetails?.private_category_metadata ?? {}) as Record<string, string | undefined>,
    deposit_required: listing.deposit_required,
    requested_deposit_amount: requirements?.requested_deposit_amount ?? undefined,
    driving_licence_required: requirements?.driving_licence_required ?? false,
    licence_class: requirements?.licence_class ?? null,
    merchantAuthenticated: true,
    merchantRole: 'merchant',
    merchantKycStatus: merchant?.kyc_status ?? 'none',
    merchantUnityScore: merchant?.unity_score ?? 0,
  }

  const completeness = computeListingCompleteness(completenessInput)

  const eligibility = checkActivationEligibility({
    ...completenessInput,
    listingStatus: listing.status,
    moderationStatus: moderation?.moderation_status ?? null,
    ownershipVerificationStatus: ownershipStatus,
    riskTier,
    insuranceAmount: listing.insurance_amount,
  })

  const merchantAccountStatus = (merchant?.account_status ?? 'active') as AccountStatus
  if (merchantAccountStatus && blocksNewTransactions(merchantAccountStatus)) {
    eligibility.reasons.push('The merchant account is suspended and cannot have listings activated.')
  }
  const finalEligibility = { eligible: eligibility.eligible && !blocksNewTransactions(merchantAccountStatus), reasons: eligibility.reasons }

  if (!finalEligibility.eligible) {
    return NextResponse.json({ error: 'This listing is not eligible for activation', eligibility: finalEligibility, completeness }, { status: 422 })
  }

  const { data, error } = await activateListing(admin, listingId, gate.requester.userId, parsed.data.idempotency_key)

  if (error) {
    console.error('[admin.listings.activate] RPC error', { listingId, error })
    const mapped = mapAdminRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  try {
    const ctx = await loadListingEmailContext(admin, listingId)
    if (ctx) {
      await sendTemplate(admin, {
        eventType: 'listing.activated',
        templateId: 'listing-activated-merchant',
        recipientUserId: ctx.merchantId,
        relatedEntityType: 'listing',
        relatedEntityId: listingId,
        vars: { merchantName: ctx.merchantName, listingTitle: ctx.listingTitle },
      })
    }
  } catch (emailErr) {
    console.error('[admin.listings.activate] email dispatch failed', { listingId, emailErr })
  }

  return NextResponse.json(data)
}
