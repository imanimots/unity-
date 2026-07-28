export type UserRole = 'renter' | 'merchant' | 'both' | 'admin'
export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected'
export type ListingStatus = 'draft' | 'pending' | 'active' | 'paused' | 'rented'
export type BookingStatus = 'pending' | 'approved' | 'active' | 'returned' | 'disputed' | 'cancelled'
export type ShippingPayer = 'renter' | 'merchant' | 'split' | 'negotiate'
export type ItemCondition = 'new' | 'like_new' | 'good' | 'fair'
export type MediaType = 'photo' | 'video' | 'ownership_proof'

/**
 * Automatically assigned by the Risk Engine (server-side trigger) — never
 * set or overridden by merchants, renters, or the client. See
 * docs/RISK_ENGINE.md.
 */
export type RiskTier = 'low' | 'medium' | 'high'

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
  merchant?: Profile
  media?: ListingMedia[]
}

export interface ListingMedia {
  id: string
  listing_id: string
  url: string
  type: MediaType
  display_order: number
  created_at: string
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
