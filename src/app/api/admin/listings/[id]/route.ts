import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { computeListingCompleteness } from '@/lib/listings/completeness'
import { checkActivationEligibility } from '@/lib/listings/activation'
import { getRiskRequirements } from '@/lib/risk/engine'
import type { RiskTier } from '@/lib/risk/engine'
import { listOwnershipEvidence } from '@/lib/listings/evidence-access'
import type { OwnershipVerificationStatus } from '@/lib/ownership-verification'
import type { KycStatus } from '@/types'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/admin/listings/[id] -- the full review detail: public listing
 * info, private evidence METADATA only (never a URL -- see
 * src/lib/listings/evidence-access.ts for the separate signed-URL route),
 * risk/completeness, and activation eligibility. Private fields
 * (listing_private_details, admin_action_history) are included here
 * because this route itself is already admin-gated -- the "do not expose
 * private evidence in the queue" rule is about the QUEUE, not this
 * single-listing detail view an admin explicitly opened.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: listingId } = await params
  if (!isValidUuid(listingId)) {
    return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:listings:detail')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const [{ data: listing, error: listingError }, { data: privateDetails }, { data: requirements }, { data: mediaRows }, { data: moderation }, { data: ownership }, { data: history }, { data: adminHistory }, { data: declarations }] =
    await Promise.all([
      admin.from('listings').select('*, profiles!listings_merchant_id_fkey(full_name, kyc_status, unity_score, created_at)').eq('id', listingId).maybeSingle(),
      admin.from('listing_private_details').select('*').eq('listing_id', listingId).maybeSingle(),
      admin.from('listing_requirements').select('*').eq('listing_id', listingId).maybeSingle(),
      admin.from('listing_media').select('id, type, shot_type, url, display_order').eq('listing_id', listingId).neq('type', 'ownership_proof'),
      admin.from('listing_moderation').select('*').eq('listing_id', listingId).maybeSingle(),
      admin.from('listing_ownership_verification').select('*').eq('listing_id', listingId).maybeSingle(),
      admin.from('listing_history').select('*').eq('listing_id', listingId).order('created_at', { ascending: false }),
      admin.from('admin_action_history').select('*').eq('listing_id', listingId).order('created_at', { ascending: false }),
      admin.from('listing_declarations').select('declaration_type, accepted, accepted_at').eq('listing_id', listingId).order('accepted_at', { ascending: false }),
    ])

  if (listingError || !listing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
  }

  const evidence = await listOwnershipEvidence(admin, listingId)

  const photos = (mediaRows ?? []).filter((m) => m.type === 'photo')
  const hasOwnershipProof = evidence.length > 0
  const hasPrimaryPhoto = photos.some((m) => m.shot_type === 'primary')
  const hasDamagePhoto = photos.some((m) => m.shot_type === 'damage_closeup')

  // listing_declarations is append-only -- a resubmission adds a fresh row
  // per declaration_type rather than updating the prior one (immutable by
  // design, see 20260803000006). Keep only the latest row per type here
  // (the query is already ordered by accepted_at desc) so the review
  // page's declaration list and the completeness input both reflect
  // current acceptance, not every historical acceptance.
  const latestDeclarationByType = new Map<string, { declaration_type: string; accepted: boolean; accepted_at: string }>()
  for (const d of declarations ?? []) {
    if (!latestDeclarationByType.has(d.declaration_type)) latestDeclarationByType.set(d.declaration_type, d)
  }
  const latestDeclarations = Array.from(latestDeclarationByType.values())
  const acceptedDeclarationTypes = latestDeclarations.filter((d) => d.accepted).map((d) => d.declaration_type)

  const merchantProfile = (listing as unknown as { profiles?: { full_name: string | null; kyc_status: string; unity_score: number; created_at: string } })
    .profiles

  const riskTier = (listing.risk_tier as RiskTier) ?? 'low'
  const riskRequirements = getRiskRequirements(riskTier)
  const ownershipStatus: OwnershipVerificationStatus = ownership?.status ?? (riskRequirements.ownershipVerificationRequired ? 'pending' : 'not_required')

  const completenessInput = {
    title: listing.title,
    category: listing.category,
    condition: listing.condition ?? undefined,
    description: listing.description ?? undefined,
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
    merchantKycStatus: (merchantProfile?.kyc_status ?? 'none') as KycStatus,
    merchantUnityScore: merchantProfile?.unity_score ?? 0,
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

  return NextResponse.json({
    listing: {
      id: listing.id,
      title: listing.title,
      category: listing.category,
      subcategoryId: listing.subcategory_id,
      description: listing.description,
      condition: listing.condition,
      knownDefects: listing.known_defects,
      wearDescription: listing.wear_description,
      dailyRate: listing.daily_rate,
      weeklyRate: listing.weekly_rate,
      replacementValue: listing.replacement_value,
      availableFrom: listing.available_from,
      province: listing.province,
      city: listing.city,
      status: listing.status,
      riskTier,
      merchantId: listing.merchant_id,
      merchantName: merchantProfile?.full_name ?? null,
      merchantKycStatus: merchantProfile?.kyc_status ?? 'none',
      merchantUnityScore: merchantProfile?.unity_score ?? null,
      merchantSince: merchantProfile?.created_at ?? null,
      createdAt: listing.created_at,
    },
    media: photos,
    ownershipEvidence: evidence,
    privateDetails: privateDetails
      ? {
          purchaseDate: privateDetails.purchase_date,
          purchasePrice: privateDetails.purchase_price,
          retailerOrSeller: privateDetails.retailer_or_seller,
          serialNumber: privateDetails.serial_number,
          privateCategoryMetadata: privateDetails.private_category_metadata,
        }
      : null,
    requirements: requirements ?? null,
    declarations: latestDeclarations,
    moderation: moderation ?? { moderation_status: 'pending', moderation_notes: null, rejection_reason: null, moderated_by: null, moderated_at: null },
    ownershipVerification: ownership ?? { status: ownershipStatus, reviewer_notes: null, merchant_feedback: null, reviewed_by: null, reviewed_at: null },
    riskRequirements,
    completeness,
    activationEligibility: eligibility,
    history: history ?? [],
    adminActionHistory: adminHistory ?? [],
  })
}
