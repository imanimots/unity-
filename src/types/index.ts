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

/**
 * See docs/BUYING_SELLING.md — 'both' means one listing row carries a
 * daily_rate AND a sale_price simultaneously (not two separate listings),
 * so the same quantity_available governs both paths and a unit can never
 * be double-committed to a rental and a sale at once.
 */
export type ListingType = 'rental' | 'sale' | 'both'
export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'disputed' | 'cancelled'

/**
 * See the Barter Marketplace MVP Implementation Plan — one barter_agreements
 * row per negotiation thread (never re-created for a counter-offer);
 * 'draft' is deliberately not a value here, matching how bookings are
 * created directly at 'requested' — a proposer's in-progress offer is
 * client-side state only, never persisted until propose_barter succeeds.
 */
export type BarterStatus =
  | 'proposed' | 'countered' | 'accepted' | 'preparing' | 'in_transit'
  | 'awaiting_confirmation' | 'completed'
  | 'rejected' | 'cancelled' | 'expired' | 'disputed'

export type BarterOfferStatus = 'pending' | 'accepted' | 'superseded' | 'rejected' | 'withdrawn'
export type BarterDeliveryMethod = 'meet_in_person' | 'courier' | 'self_collection' | 'other'
export type BarterDeliveryResponsibility = 'party_a' | 'party_b' | 'shared' | 'each_handles_own' | 'not_applicable'
export type BarterDepositPayer = 'party_a' | 'party_b' | 'both'
export type BarterUserAgentCategory = 'mobile' | 'desktop' | 'unknown'

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
  // Nullable since the buying/selling migration — a pure 'sale' listing
  // has no daily_rate at all. See listings_type_pricing_chk: exactly the
  // fields matching listing_type are ever set.
  daily_rate: number | null
  weekly_rate: number | null
  min_rental_days: number
  // Added by the buying/selling migration (20260720000003) — not
  // previously reflected here; optional since it predates this and older
  // mock fixtures don't set it.
  quantity_available?: number
  listing_type?: ListingType
  sale_price?: number | null
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
  // QA/regression/demo fixture marker (Unity SEO Pre-Launch Hardening) —
  // optional since mock fixtures predate this column.
  is_test?: boolean
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

/**
 * Parallel to Booking, for sale listings — see docs/BUYING_SELLING.md.
 * Every field here is authored directly against the live migration SQL
 * (supabase/migrations/20260812000003_orders_schema_hardening.sql),
 * deliberately avoiding the drift already present in Booking/BookingStatus
 * elsewhere in this file (which still reflect a pre-hardening schema).
 * `payfast_payment_id` is a legacy, unused column — see
 * docs/PAYMENT_ARCHITECTURE.md — real payment status lives on the linked
 * `payments` row (payment_type='order_payment'), not here.
 */
export interface Order {
  id: string
  order_reference: string
  listing_id: string
  buyer_id: string
  seller_id: string
  quantity: number
  unit_price: number
  shipping_fee: number
  total_amount: number
  status: OrderStatus
  pre_sale_media_url: string | null
  payfast_payment_id: string | null
  affiliate_id: string | null
  affiliate_commission_amount: number | null
  paid_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancellation_reason: string | null
  created_at: string
  listing?: Listing
  buyer?: Profile
  seller?: Profile
}

/** Append-only, same shape and shared immutability trigger as BookingHistory/BarterHistoryEntry. */
export interface OrderHistoryEntry {
  id: string
  order_id: string
  actor_user_id: string | null
  actor_role: 'buyer' | 'seller' | 'system' | 'admin'
  event_type: string
  previous_status: OrderStatus | null
  new_status: OrderStatus
  metadata: Record<string, unknown>
  created_at: string
}

export type DisputeStatus = 'open' | 'evidence' | 'under_review' | 'resolved' | 'closed' | 'cancelled' | 'escalated'
export type DisputeOutcome = 'favor_raiser' | 'favor_respondent' | 'mutual_agreement' | 'manual_settlement'

/**
 * The one generic dispute resource reused identically by bookings,
 * orders, and barter — exactly one of booking_id/order_id/
 * barter_agreement_id is ever set (enforced by disputes_one_transaction_chk).
 * Authored directly against the live migration SQL (supabase/migrations/
 * 20260814000002_disputes_schema_hardening.sql), not a hoped-for shape.
 */
export interface Dispute {
  id: string
  booking_id: string | null
  order_id: string | null
  barter_agreement_id: string | null
  raised_by: string
  title: string
  reason: string | null
  description: string
  requested_resolution: string
  status: DisputeStatus
  assigned_admin_id: string | null
  outcome: DisputeOutcome | null
  resolution_notes: string | null
  resolved_by: string | null
  resolved_at: string | null
  closed_by: string | null
  closed_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  cancellation_reason: string | null
  evidence_requested_by: string | null
  evidence_requested_at: string | null
  evidence_request_note: string | null
  created_at: string
  updated_at: string
}

/** Append-only, same shape/immutability trigger as OrderHistoryEntry/BarterHistoryEntry. */
export interface DisputeHistoryEntry {
  id: string
  dispute_id: string
  actor_user_id: string | null
  actor_role: 'raiser' | 'respondent' | 'admin' | 'system'
  event_type: string
  previous_status: string | null
  new_status: string | null
  metadata: Record<string, unknown>
  created_at: string
}

/** Immutable, append-only — no update/delete client policy exists at all, mirrors BarterOfferMedia's storage-plus-table pattern. */
export interface DisputeEvidence {
  id: string
  dispute_id: string
  uploaded_by: string
  storage_path: string
  file_type: 'image' | 'pdf' | 'document'
  display_order: number
  created_at: string
}

/**
 * One row per negotiation thread — id is never re-pointed by a counter,
 * chat/disputes/payments/history all link to it. accepted_offer_id is
 * set exactly once by accept_barter_offer() and never changes again,
 * which is what makes accepted terms immutable. Every field here is
 * authored directly against the live migration SQL (supabase/migrations/
 * 20260810000003_barter_schema.sql), not against a hoped-for shape —
 * deliberately avoiding the drift already present in Booking/BookingStatus
 * above (which still reflect the pre-Phase-2B schema).
 */
export interface BarterAgreement {
  id: string
  agreement_reference: string
  anchor_listing_id: string
  party_a_id: string
  party_b_id: string
  status: BarterStatus
  current_offer_id: string | null
  accepted_offer_id: string | null
  version: number
  admin_hold: boolean
  admin_hold_reason: string | null
  proposed_at: string
  accepted_at: string | null
  rejected_at: string | null
  rejected_by: string | null
  rejection_reason: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancellation_reason: string | null
  cancellation_settlement: string | null
  expires_at: string | null
  completed_at: string | null
  disputed_at: string | null
  updated_at: string
  anchor_listing?: Listing
  party_a?: Profile
  party_b?: Profile
  current_offer?: BarterOffer
  accepted_offer?: BarterOffer
}

/** One row per negotiation round — a complete replacement package, never a partial patch against the previous version. */
export interface BarterOffer {
  id: string
  agreement_id: string
  version: number
  proposed_by: string
  status: BarterOfferStatus
  cash_adjustment_amount: number
  cash_adjustment_payer: string | null
  delivery_method: BarterDeliveryMethod
  delivery_notes: string | null
  delivery_responsibility: BarterDeliveryResponsibility | null
  deposit_required: boolean
  deposit_amount: number | null
  deposit_currency: string
  deposit_payer: BarterDepositPayer | null
  message: string | null
  created_at: string
  items?: BarterOfferItem[]
  media?: BarterOfferMedia[]
}

/** offered_by identifies which party contributed this listing — validated server-side against listings.merchant_id, never trusted from the client. */
export interface BarterOfferItem {
  id: string
  offer_id: string
  listing_id: string
  offered_by: string
  created_at: string
  listing?: Listing
}

/** Optional evidence photos/videos scoped to a specific offer version — part of the versioned contractual record, distinct from chat. */
export interface BarterOfferMedia {
  id: string
  offer_id: string
  uploaded_by: string
  storage_path: string
  media_type: 'photo' | 'video'
  display_order: number
  created_at: string
}

/**
 * One row per party per agreement — completion only occurs once both
 * exist. No IP address is captured (POPIA-conscious minimal collection);
 * user_agent_category is a coarse bucket, never a raw UA string.
 */
export interface BarterConfirmation {
  id: string
  agreement_id: string
  party_id: string
  confirmation_note: string | null
  user_agent_category: BarterUserAgentCategory | null
  confirmed_at: string
}

/** Append-only, same shape and shared immutability trigger as BookingHistory. */
export interface BarterHistoryEntry {
  id: string
  agreement_id: string
  actor_user_id: string | null
  actor_role: 'party_a' | 'party_b' | 'system' | 'admin'
  event_type: string
  previous_status: BarterStatus | null
  new_status: BarterStatus
  metadata: Record<string, unknown>
  created_at: string
}

/**
 * Step 11 Phase 4 -- a deposit or cash-adjustment payment row scoped to
 * a barter agreement. renter_id/merchant_id are repurposed as generic
 * payer/counterparty ids (same repurposing precedent orders already
 * established for buyer_id/seller_id).
 */
export interface BarterPayment {
  id: string
  barter_agreement_id: string
  renter_id: string
  merchant_id: string
  payment_type: 'barter_deposit' | 'barter_cash_adjustment'
  status: string
  amount: number
  currency: string
  provider: string
  created_at: string
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

export interface MessageAttachment {
  id: string
  message_id: string
  uploaded_by: string
  storage_path: string
  file_type: 'image' | 'pdf' | 'document'
  created_at: string
}

export interface Message {
  id: string
  booking_id: string | null
  order_id: string | null
  barter_agreement_id: string | null
  dispute_id: string | null
  sender_id: string
  content: string
  is_filtered: boolean
  filter_reason: string | null
  created_at: string
  sender?: Profile
  attachments?: MessageAttachment[]
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
