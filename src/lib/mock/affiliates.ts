export type AffiliateStatus = 'pending' | 'paid'

export interface MockAffiliateReferral {
  id: string
  listing_id: string
  listing_title: string
  affiliate_name: string  // display name only — never expose contact details
  booking_ref: string
  rental_date: string
  rental_fee: number
  commission_rate: number
  commission_amount: number
  status: AffiliateStatus
}

// Referrals made to listings owned by user-1 (Thabo)
export const MOCK_AFFILIATE_REFERRALS: MockAffiliateReferral[] = [
  {
    id: 'aff-1',
    listing_id: 'listing-13',
    listing_title: 'Nikon Z6 II Mirrorless Camera + 24-70mm',
    affiliate_name: 'Sipho M.',
    booking_ref: 'UNI-A3F2K1',
    rental_date: '2026-05-20',
    rental_fee: 1200,
    commission_rate: 8,
    commission_amount: 96,
    status: 'paid',
  },
  {
    id: 'aff-2',
    listing_id: 'listing-13',
    listing_title: 'Nikon Z6 II Mirrorless Camera + 24-70mm',
    affiliate_name: 'Kagiso T.',
    booking_ref: 'UNI-B7D9X4',
    rental_date: '2026-06-02',
    rental_fee: 900,
    commission_rate: 8,
    commission_amount: 72,
    status: 'pending',
  },
  {
    id: 'aff-3',
    listing_id: 'listing-13',
    listing_title: 'Nikon Z6 II Mirrorless Camera + 24-70mm',
    affiliate_name: 'Sipho M.',
    booking_ref: 'UNI-C2M8P7',
    rental_date: '2026-06-08',
    rental_fee: 600,
    commission_rate: 8,
    commission_amount: 48,
    status: 'pending',
  },
  {
    id: 'aff-4',
    listing_id: 'listing-14',
    listing_title: 'Campmaster 4-Person Tent + Sleeping Bags',
    affiliate_name: 'Lerato K.',
    booking_ref: 'UNI-D5J3T2',
    rental_date: '2026-04-14',
    rental_fee: 500,
    commission_rate: 0,
    commission_amount: 0,
    status: 'paid',
  },
]
