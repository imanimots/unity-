export type UserRole = 'renter' | 'merchant' | 'both' | 'admin'
export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected'
export type ListingStatus = 'draft' | 'pending' | 'active' | 'paused' | 'rented'
export type BookingStatus = 'pending' | 'approved' | 'active' | 'returned' | 'disputed' | 'cancelled'
export type ShippingPayer = 'renter' | 'merchant' | 'split' | 'negotiate'
export type ItemCondition = 'new' | 'like_new' | 'good' | 'fair'
export type MediaType = 'photo' | 'video' | 'ownership_proof'

/**
 * See docs/LISTING_SCHEMA.md (supabase/migrations/20260729000002 onward)
 * for the full rationale behind every type/interface below this line.
 */
export type OwnershipProofType =
  | 'receipt' | 'invoice' | 'warranty' | 'registration'
  | 'affidavit' | 'asset_register' | 'finance_agreement' | 'other'

export type MediaShotType =
  | 'primary' | 'front' | 'rear' | 'side'
  | 'condition_closeup' | 'damage_closeup' | 'serial_mark'

export type DepositBasis = 'fixed' | 'percentage' | 'system_calculated'

export type DeclarationType =
  | 'ownership_authority' | 'condition_accuracy' | 'image_accuracy'
  | 'legal_and_safe_item' | 'platform_terms' | 'off_platform_transaction_policy'

export type ModerationStatus = 'pending' | 'approved' | 'rejected' | 'requires_review' | 'flagged'

/**
 * Automatically assigned by the Risk Engine (server-side trigger) — never
 * set or overridden by merchants, renters, or the client. See
 * docs/RISK_ENGINE.md.
 */
export type RiskTier = 'low' | 'medium' | 'high'

export type AccountStatus = 'active' | 'restricted' | 'suspended'

export interface Profile {
  id: string
  full_name: string | null
  display_name: string | null
  phone: string | null
  role: UserRole
  kyc_status: KycStatus
  unity_score: number
  country_id: string
  avatar_url: string | null
  is_affiliate: boolean
  affiliate_code: string | null
  account_status: AccountStatus
  status_reason: string | null
  status_changed_at: string | null
  status_changed_by: string | null
  created_at: string
}

export interface Country {
  id: string
  name: string
  currency: string
  active: boolean
}

export interface Listing {
  id: string
  merchant_id: string
  country_id: string
  title: string
  description: string | null
  category: string
  condition: ItemCondition | null
  daily_rate: number
  weekly_rate: number | null
  min_rental_days: number
  // Added by the buying/selling migration (20260720000003) — not
  // previously reflected here; optional since it predates this and older
  // mock fixtures don't set it.
  quantity_available?: number
  deposit_required: boolean
  deposit_amount: number | null
  insurance_amount: number | null
  shipping_payer: ShippingPayer
  min_unity_score: number
  risk_tier: RiskTier
  accepts_affiliates: boolean
  affiliate_commission_rate: number
  status: ListingStatus
  ownership_verified: boolean
  created_at: string
  // Everything below was added in Phase 2A (docs/LISTING_SCHEMA.md) and is
  // optional here — existing mock fixtures in src/lib/mock/data.ts predate
  // these columns and aren't required to set them, matching how `merchant`/
  // `media` are already modeled as optional on this same interface.
  category_id?: string | null
  subcategory_id?: string | null
  // Item detail
  brand?: string | null
  model?: string | null
  replacement_value?: number | null
  year_of_manufacture?: number | null
  colour?: string | null
  size?: string | null
  specifications?: string | null
  included_accessories?: string | null
  tags?: string[] | null
  // Location
  province?: string | null
  city?: string | null
  collection_area?: string | null
  // Condition disclosure (deliberately public)
  known_defects?: string | null
  wear_description?: string | null
  functional_status?: string | null
  missing_parts?: string | null
  repair_history?: string | null
  condition_confirmed?: boolean
  // Pricing extension
  weekend_rate?: number | null
  monthly_rate?: number | null
  max_rental_days?: number | null
  // Availability scalars (blocked date ranges live in ListingAvailability)
  available_from?: string | null
  min_booking_notice_days?: number | null
  max_advance_booking_days?: number | null
  recurring_unavailable_weekdays?: number[] | null
  // Handover
  pickup_available?: boolean
  delivery_available?: boolean
  merchant_delivery_available?: boolean
  courier_allowed?: boolean
  renter_collection_allowed?: boolean
  preferred_handover_times?: string | null
  // Ownership (low-sensitivity only — see ListingPrivateDetails for the rest)
  ownership_proof_type?: OwnershipProofType | null
  ownership_declaration_accepted?: boolean
  // Affiliate extension
  promotional_terms?: string | null
  campaign_start_date?: string | null
  campaign_end_date?: string | null
  // Non-sensitive category-specific display attributes only — see
  // docs/LISTING_SCHEMA.md's promotion rule before adding a key here.
  category_metadata?: Record<string, unknown> | null
  merchant?: Profile
  media?: ListingMedia[]
}

export interface ListingMedia {
  id: string
  listing_id: string
  url: string
  type: MediaType
  display_order: number
  shot_type?: MediaShotType | null
  created_at: string
}

/** Merchant + service_role read only — never selected on a public listing read. */
export interface ListingPrivateDetails {
  listing_id: string
  purchase_date: string | null
  purchase_price: number | null
  retailer_or_seller: string | null
  serial_number: string | null
  handover_instructions: string | null
  // Sensitive category-specific identifiers (VIN, IMEI, registration number,
  // device serial, ownership-document references). Never on the public
  // Listing.category_metadata.
  private_category_metadata: Record<string, unknown> | null
  created_at: string
}

export interface ListingAvailability {
  id: string
  listing_id: string
  start_date: string
  end_date: string
  reason: string | null
  created_at: string
}

export interface ListingRequirements {
  listing_id: string
  // Renter requirements
  verified_identity_required: boolean
  kyc_approved_required: boolean
  proof_of_address_required: boolean
  min_age: number | null
  driving_licence_required: boolean
  licence_class: string | null
  bank_statement_required: boolean
  proof_of_employment_required: boolean
  prior_rental_history_required: boolean
  refundable_deposit_required: boolean
  additional_requirements: string | null
  // Usage rules
  permitted_use: string | null
  prohibited_use: string | null
  indoor_outdoor_restriction: string | null
  geographic_restriction: string | null
  mileage_limit: number | null
  max_users: number | null
  commercial_use_allowed: boolean
  sub_rental_allowed: boolean
  pets_allowed: boolean | null
  smoking_allowed: boolean | null
  cleaning_requirements: string | null
  return_condition_requirements: string | null
  consumable_return_requirements: string | null
  required_protective_equipment: string | null
  supervision_required: boolean
  operating_instructions: string | null
  merchant_custom_rules: string | null
  // Damage / liability
  existing_damage_description: string | null
  damage_policy_acknowledged: boolean
  merchant_provides_insurance: boolean
  renter_insurance_required: boolean
  excess_amount: number | null
  inspection_required_before_handover: boolean
  inspection_required_on_return: boolean
  cleaning_fee_conditions: string | null
  lost_item_consequence: string | null
  missing_accessory_consequence: string | null
  // Cancellation — deliberately no refund-percentage/penalty fields
  merchant_cancellation_notice_hours: number | null
  renter_cancellation_notice_hours: number | null
  auto_approval_enabled: boolean
  cancellation_reason_required: boolean
  // Deposit basis — final_deposit_amount is server-computed, see
  // docs/LISTING_SCHEMA.md
  deposit_basis: DepositBasis
  requested_deposit_amount: number | null
  final_deposit_amount: number | null
  created_at: string
}

/** Append-only — merchant reads own, no update/delete. */
export interface ListingDeclaration {
  id: string
  listing_id: string
  merchant_id: string
  declaration_type: DeclarationType
  declaration_version: string
  declaration_text_hash: string
  accepted: boolean
  accepted_at: string
  ip_address: string | null
  user_agent: string | null
  created_at: string
}

/** Base table is admin/service_role only — merchants read via listing_moderation_merchant_view. */
export interface ListingModeration {
  listing_id: string
  moderation_status: ModerationStatus
  moderation_notes: string | null
  moderated_by: string | null
  moderated_at: string | null
  rejection_reason: string | null
  created_at: string
  updated_at: string
}

/** The merchant-safe subset exposed by listing_moderation_merchant_view. */
export interface ListingModerationSummary {
  listing_id: string
  moderation_status: ModerationStatus
  rejection_reason: string | null
  moderated_at: string | null
}

export interface Category {
  id: string
  slug: string
  name: string
  description: string | null
  is_active: boolean
  sort_order: number
}

export interface Subcategory {
  id: string
  category_id: string
  slug: string
  name: string
  description: string | null
  is_active: boolean
  sort_order: number
}

export interface Booking {
  id: string
  listing_id: string
  renter_id: string
  merchant_id: string
  start_date: string
  end_date: string
  total_days: number
  rental_fee: number
  deposit_amount: number
  shipping_fee: number
  total_amount: number
  status: BookingStatus
  pre_rental_media_url: string | null
  post_rental_media_url: string | null
  payfast_payment_id: string | null
  affiliate_id: string | null
  affiliate_commission_amount: number | null
  created_at: string
  listing?: Listing
  renter?: Profile
  merchant?: Profile
}

export interface Review {
  id: string
  booking_id: string
  reviewer_id: string
  reviewee_id: string
  rating: number
  comment: string | null
  created_at: string
  reviewer?: Profile
}

export interface Dispute {
  id: string
  booking_id: string
  raised_by: string
  reason: string | null
  evidence_urls: string[]
  status: 'open' | 'resolved' | 'escalated'
  resolution_notes: string | null
  created_at: string
}

export interface Message {
  id: string
  booking_id: string
  sender_id: string
  content: string
  is_filtered: boolean
  filter_reason: string | null
  created_at: string
  sender?: Profile
}

export interface AffiliateReferral {
  id: string
  affiliate_id: string
  referred_user_id: string | null
  listing_id: string | null
  booking_id: string | null
  commission_amount: number | null
  status: 'pending' | 'paid' | 'cancelled'
  created_at: string
}

export const CATEGORIES = [
  { id: 'tech', label: 'Tech & Electronics', icon: '💻' },
  { id: 'outdoor', label: 'Outdoor & Camping', icon: '🏕️' },
  { id: 'tools', label: 'Tools & DIY', icon: '🔧' },
  { id: 'fashion', label: 'Luxury Fashion', icon: '👜' },
  { id: 'events', label: 'Events & Party', icon: '🎉' },
  { id: 'vehicles', label: 'Vehicles', icon: '🚗' },
  { id: 'music', label: 'Musical Instruments', icon: '🎸' },
  { id: 'sports', label: 'Sports & Fitness', icon: '⚽' },
  { id: 'baby', label: 'Baby & Kids', icon: '🧸' },
] as const

export type CategoryId = typeof CATEGORIES[number]['id']
