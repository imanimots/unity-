// ─── Types ────────────────────────────────────────────────────────────────────

export type AdminUser = {
  id: string
  full_name: string
  email: string
  role: 'renter' | 'merchant' | 'admin'
  kyc_status: 'unverified' | 'pending' | 'approved' | 'rejected'
  unity_score: number
  is_affiliate: boolean
  affiliate_code: string | null
  status: 'active' | 'suspended'
  listings_count: number
  bookings_count: number
  created_at: string
}

export type AdminListing = {
  id: string
  title: string
  merchant_id: string
  merchant_name: string
  category: string
  status: 'active' | 'paused' | 'draft' | 'flagged'
  daily_rate: number
  bookings_count: number
  rating: number
  created_at: string
}

export type AdminBooking = {
  id: string
  listing_title: string
  listing_id: string
  renter_id: string
  renter_name: string
  merchant_name: string
  start_date: string
  end_date: string
  daily_rate: number
  days: number
  deposit: number
  total_amount: number
  status: 'pending' | 'active' | 'completed' | 'cancelled' | 'disputed'
  created_at: string
}

export type AdminDispute = {
  id: string
  booking_id: string
  listing_title: string
  raised_by: string
  raised_by_role: 'renter' | 'merchant'
  against: string
  reason: string
  description: string
  amount_at_stake: number
  status: 'open' | 'resolved' | 'escalated' | 'pending_evidence'
  priority: 'high' | 'medium' | 'low'
  created_at: string
  evidence: string[]
  resolution?: string
  resolved_in_favour_of?: 'renter' | 'merchant'
  resolved_at?: string
}

// ─── Mock Users ───────────────────────────────────────────────────────────────

export const ADMIN_MOCK_USERS: AdminUser[] = [
  { id: 'u-1',  full_name: 'Imani Mokoena',    email: 'imani@example.co.za',   role: 'merchant', kyc_status: 'approved',   unity_score: 4.8, is_affiliate: true,  affiliate_code: 'AFC-IM48', status: 'active',    listings_count: 6,  bookings_count: 42, created_at: '2026-01-15' },
  { id: 'u-2',  full_name: 'Sipho Dlamini',    email: 'sipho@example.co.za',   role: 'renter',   kyc_status: 'approved',   unity_score: 4.2, is_affiliate: false, affiliate_code: null,       status: 'active',    listings_count: 0,  bookings_count: 18, created_at: '2026-01-22' },
  { id: 'u-3',  full_name: 'Ayesha Patel',     email: 'ayesha@example.co.za',  role: 'merchant', kyc_status: 'approved',   unity_score: 4.6, is_affiliate: true,  affiliate_code: 'AFC-AP46', status: 'active',    listings_count: 4,  bookings_count: 31, created_at: '2026-02-03' },
  { id: 'u-4',  full_name: 'Thabo Nkosi',      email: 'thabo@example.co.za',   role: 'renter',   kyc_status: 'pending',    unity_score: 0.0, is_affiliate: false, affiliate_code: null,       status: 'active',    listings_count: 0,  bookings_count: 0,  created_at: '2026-02-18' },
  { id: 'u-5',  full_name: 'Lerato Sithole',   email: 'lerato@example.co.za',  role: 'merchant', kyc_status: 'approved',   unity_score: 3.9, is_affiliate: false, affiliate_code: null,       status: 'active',    listings_count: 2,  bookings_count: 14, created_at: '2026-02-25' },
  { id: 'u-6',  full_name: 'Marco van Wyk',    email: 'marco@example.co.za',   role: 'renter',   kyc_status: 'unverified', unity_score: 0.0, is_affiliate: false, affiliate_code: null,       status: 'active',    listings_count: 0,  bookings_count: 0,  created_at: '2026-03-01' },
  { id: 'u-7',  full_name: 'Zanele Khumalo',   email: 'zanele@example.co.za',  role: 'merchant', kyc_status: 'approved',   unity_score: 4.5, is_affiliate: true,  affiliate_code: 'AFC-ZK45', status: 'active',    listings_count: 8,  bookings_count: 67, created_at: '2026-01-08' },
  { id: 'u-8',  full_name: 'Ruan Botha',       email: 'ruan@example.co.za',    role: 'renter',   kyc_status: 'approved',   unity_score: 3.7, is_affiliate: false, affiliate_code: null,       status: 'suspended', listings_count: 0,  bookings_count: 5,  created_at: '2026-03-10' },
  { id: 'u-9',  full_name: 'Naledi Moroe',     email: 'naledi@example.co.za',  role: 'renter',   kyc_status: 'approved',   unity_score: 4.1, is_affiliate: true,  affiliate_code: 'AFC-NM41', status: 'active',    listings_count: 0,  bookings_count: 23, created_at: '2026-02-14' },
  { id: 'u-10', full_name: 'Dirk Fourie',      email: 'dirk@example.co.za',    role: 'merchant', kyc_status: 'rejected',   unity_score: 0.0, is_affiliate: false, affiliate_code: null,       status: 'active',    listings_count: 0,  bookings_count: 0,  created_at: '2026-03-20' },
  { id: 'u-11', full_name: 'Priya Naidoo',     email: 'priya@example.co.za',   role: 'renter',   kyc_status: 'approved',   unity_score: 4.9, is_affiliate: false, affiliate_code: null,       status: 'active',    listings_count: 0,  bookings_count: 38, created_at: '2026-01-30' },
  { id: 'u-12', full_name: 'Kagiso Motsepe',   email: 'kagiso@example.co.za',  role: 'merchant', kyc_status: 'approved',   unity_score: 4.3, is_affiliate: true,  affiliate_code: 'AFC-KM43', status: 'active',    listings_count: 5,  bookings_count: 28, created_at: '2026-02-07' },
  { id: 'u-13', full_name: 'Lisa Terblanche',  email: 'lisa@example.co.za',    role: 'renter',   kyc_status: 'pending',    unity_score: 0.0, is_affiliate: false, affiliate_code: null,       status: 'active',    listings_count: 0,  bookings_count: 1,  created_at: '2026-04-01' },
  { id: 'u-14', full_name: 'Bongani Zulu',     email: 'bongani@example.co.za', role: 'renter',   kyc_status: 'approved',   unity_score: 3.5, is_affiliate: false, affiliate_code: null,       status: 'active',    listings_count: 0,  bookings_count: 9,  created_at: '2026-03-05' },
  { id: 'u-15', full_name: 'Sarah Adams',      email: 'sarah@example.co.za',   role: 'merchant', kyc_status: 'approved',   unity_score: 4.7, is_affiliate: true,  affiliate_code: 'AFC-SA47', status: 'active',    listings_count: 3,  bookings_count: 19, created_at: '2026-01-12' },
]

// ─── Mock Listings ────────────────────────────────────────────────────────────

export const ADMIN_MOCK_LISTINGS: AdminListing[] = [
  { id: 'l-1',  title: 'DJI Mavic 3 Pro Drone + ND Filters',          merchant_id: 'u-1',  merchant_name: 'Imani Mokoena',  category: 'Drones',      status: 'active',  daily_rate: 800,  bookings_count: 22, rating: 4.9, created_at: '2026-01-20' },
  { id: 'l-2',  title: 'Sony A7R V Camera + 50mm Lens',               merchant_id: 'u-7',  merchant_name: 'Zanele Khumalo', category: 'Cameras',     status: 'active',  daily_rate: 600,  bookings_count: 18, rating: 4.7, created_at: '2026-01-25' },
  { id: 'l-3',  title: 'Campmaster 4-Person Tent + Sleeping Bags',    merchant_id: 'u-3',  merchant_name: 'Ayesha Patel',   category: 'Camping',     status: 'active',  daily_rate: 200,  bookings_count: 31, rating: 4.6, created_at: '2026-02-05' },
  { id: 'l-4',  title: 'DeWalt Power Tool Set (12 pieces)',            merchant_id: 'u-5',  merchant_name: 'Lerato Sithole', category: 'Power Tools', status: 'paused',  daily_rate: 350,  bookings_count: 8,  rating: 4.4, created_at: '2026-02-28' },
  { id: 'l-5',  title: 'Yamaha PA System + Mixing Board',             merchant_id: 'u-12', merchant_name: 'Kagiso Motsepe', category: 'Audio',       status: 'active',  daily_rate: 450,  bookings_count: 14, rating: 4.5, created_at: '2026-02-10' },
  { id: 'l-6',  title: 'GoPro Hero 12 + Accessories Bundle',          merchant_id: 'u-7',  merchant_name: 'Zanele Khumalo', category: 'Cameras',     status: 'active',  daily_rate: 250,  bookings_count: 27, rating: 4.8, created_at: '2026-01-30' },
  { id: 'l-7',  title: 'Trek Mountain Bike (Medium Frame)',            merchant_id: 'u-15', merchant_name: 'Sarah Adams',    category: 'Bicycles',    status: 'active',  daily_rate: 150,  bookings_count: 12, rating: 4.3, created_at: '2026-02-20' },
  { id: 'l-8',  title: 'Epson 4K Projector + 3m Screen',              merchant_id: 'u-1',  merchant_name: 'Imani Mokoena',  category: 'Projectors',  status: 'flagged', daily_rate: 500,  bookings_count: 3,  rating: 3.8, created_at: '2026-03-15' },
  { id: 'l-9',  title: 'Nikon Z6 II Mirrorless + 24-70mm Lens',       merchant_id: 'u-3',  merchant_name: 'Ayesha Patel',   category: 'Cameras',     status: 'active',  daily_rate: 550,  bookings_count: 9,  rating: 4.6, created_at: '2026-02-08' },
  { id: 'l-10', title: 'Weber Gas BBQ Grill (6-burner)',               merchant_id: 'u-5',  merchant_name: 'Lerato Sithole', category: 'Garden',      status: 'draft',   daily_rate: 180,  bookings_count: 0,  rating: 0.0, created_at: '2026-04-02' },
  { id: 'l-11', title: 'Rode NT-USB+ Podcast Microphone Kit',         merchant_id: 'u-12', merchant_name: 'Kagiso Motsepe', category: 'Audio',       status: 'active',  daily_rate: 120,  bookings_count: 19, rating: 4.7, created_at: '2026-03-01' },
  { id: 'l-12', title: 'DJI Osmo Mobile 6 Gimbal Stabiliser',        merchant_id: 'u-7',  merchant_name: 'Zanele Khumalo', category: 'Cameras',     status: 'active',  daily_rate: 180,  bookings_count: 21, rating: 4.5, created_at: '2026-02-15' },
  { id: 'l-13', title: 'Jackery 1000W Solar Generator',               merchant_id: 'u-1',  merchant_name: 'Imani Mokoena',  category: 'Power',       status: 'active',  daily_rate: 400,  bookings_count: 7,  rating: 4.9, created_at: '2026-03-10' },
  { id: 'l-14', title: 'Canon EOS R5 + 3 Lenses + Bag',              merchant_id: 'u-15', merchant_name: 'Sarah Adams',    category: 'Cameras',     status: 'active',  daily_rate: 750,  bookings_count: 11, rating: 4.8, created_at: '2026-01-28' },
  { id: 'l-15', title: 'Festool Track Saw + Router + Accessories',    merchant_id: 'u-3',  merchant_name: 'Ayesha Patel',   category: 'Power Tools', status: 'paused',  daily_rate: 280,  bookings_count: 5,  rating: 4.2, created_at: '2026-03-18' },
]

// ─── Mock Bookings ────────────────────────────────────────────────────────────

export const ADMIN_MOCK_BOOKINGS: AdminBooking[] = [
  { id: 'b-1',  listing_title: 'DJI Mavic 3 Pro Drone',        listing_id: 'l-1',  renter_id: 'u-2',  renter_name: 'Sipho Dlamini',  merchant_name: 'Imani Mokoena',  start_date: '2026-06-01', end_date: '2026-06-03', daily_rate: 800, days: 3,  deposit: 2000, total_amount: 4400,  status: 'completed',  created_at: '2026-05-25' },
  { id: 'b-2',  listing_title: 'Sony A7R V Camera',             listing_id: 'l-2',  renter_id: 'u-9',  renter_name: 'Naledi Moroe',   merchant_name: 'Zanele Khumalo', start_date: '2026-06-05', end_date: '2026-06-07', daily_rate: 600, days: 3,  deposit: 1500, total_amount: 3300,  status: 'completed',  created_at: '2026-05-29' },
  { id: 'b-3',  listing_title: 'Campmaster 4-Person Tent',      listing_id: 'l-3',  renter_id: 'u-11', renter_name: 'Priya Naidoo',   merchant_name: 'Ayesha Patel',   start_date: '2026-06-10', end_date: '2026-06-15', daily_rate: 200, days: 5,  deposit: 500,  total_amount: 1500,  status: 'active',     created_at: '2026-06-02' },
  { id: 'b-4',  listing_title: 'DeWalt Power Tool Set',         listing_id: 'l-4',  renter_id: 'u-14', renter_name: 'Bongani Zulu',   merchant_name: 'Lerato Sithole', start_date: '2026-06-08', end_date: '2026-06-10', daily_rate: 350, days: 3,  deposit: 1000, total_amount: 2050,  status: 'disputed',   created_at: '2026-06-01' },
  { id: 'b-5',  listing_title: 'Yamaha PA System',              listing_id: 'l-5',  renter_id: 'u-2',  renter_name: 'Sipho Dlamini',  merchant_name: 'Kagiso Motsepe', start_date: '2026-06-20', end_date: '2026-06-21', daily_rate: 450, days: 1,  deposit: 800,  total_amount: 1250,  status: 'pending',    created_at: '2026-06-10' },
  { id: 'b-6',  listing_title: 'GoPro Hero 12 Bundle',          listing_id: 'l-6',  renter_id: 'u-9',  renter_name: 'Naledi Moroe',   merchant_name: 'Zanele Khumalo', start_date: '2026-06-12', end_date: '2026-06-14', daily_rate: 250, days: 2,  deposit: 600,  total_amount: 1100,  status: 'active',     created_at: '2026-06-08' },
  { id: 'b-7',  listing_title: 'Trek Mountain Bike',            listing_id: 'l-7',  renter_id: 'u-11', renter_name: 'Priya Naidoo',   merchant_name: 'Sarah Adams',    start_date: '2026-06-03', end_date: '2026-06-05', daily_rate: 150, days: 2,  deposit: 300,  total_amount: 600,   status: 'completed',  created_at: '2026-05-28' },
  { id: 'b-8',  listing_title: 'Canon EOS R5 + Lenses',         listing_id: 'l-14', renter_id: 'u-14', renter_name: 'Bongani Zulu',   merchant_name: 'Sarah Adams',    start_date: '2026-06-18', end_date: '2026-06-20', daily_rate: 750, days: 2,  deposit: 2000, total_amount: 3500,  status: 'pending',    created_at: '2026-06-11' },
  { id: 'b-9',  listing_title: 'Jackery Solar Generator',       listing_id: 'l-13', renter_id: 'u-2',  renter_name: 'Sipho Dlamini',  merchant_name: 'Imani Mokoena',  start_date: '2026-05-20', end_date: '2026-05-25', daily_rate: 400, days: 5,  deposit: 1200, total_amount: 3200,  status: 'completed',  created_at: '2026-05-14' },
  { id: 'b-10', listing_title: 'Rode Podcast Microphone Kit',   listing_id: 'l-11', renter_id: 'u-9',  renter_name: 'Naledi Moroe',   merchant_name: 'Kagiso Motsepe', start_date: '2026-06-07', end_date: '2026-06-08', daily_rate: 120, days: 1,  deposit: 250,  total_amount: 370,   status: 'completed',  created_at: '2026-06-03' },
  { id: 'b-11', listing_title: 'Nikon Z6 II Mirrorless',        listing_id: 'l-9',  renter_id: 'u-11', renter_name: 'Priya Naidoo',   merchant_name: 'Ayesha Patel',   start_date: '2026-06-25', end_date: '2026-06-27', daily_rate: 550, days: 2,  deposit: 1500, total_amount: 2600,  status: 'pending',    created_at: '2026-06-13' },
  { id: 'b-12', listing_title: 'Epson 4K Projector',            listing_id: 'l-8',  renter_id: 'u-14', renter_name: 'Bongani Zulu',   merchant_name: 'Imani Mokoena',  start_date: '2026-05-30', end_date: '2026-05-31', daily_rate: 500, days: 1,  deposit: 1000, total_amount: 1500,  status: 'disputed',   created_at: '2026-05-25' },
]

// ─── Mock Disputes ────────────────────────────────────────────────────────────

export const ADMIN_MOCK_DISPUTES: AdminDispute[] = [
  {
    id: 'd-1',
    booking_id: 'b-4',
    listing_title: 'DeWalt Power Tool Set',
    raised_by: 'Bongani Zulu',
    raised_by_role: 'renter',
    against: 'Lerato Sithole',
    reason: 'Item returned damaged',
    description: 'The merchant claims the drill bit set was returned with 3 missing bits and the case was cracked. I returned everything as received. No damage was done by me.',
    amount_at_stake: 1000,
    status: 'open',
    priority: 'medium',
    created_at: '2026-06-11',
    evidence: ['photo_return_condition.jpg', 'receipt_original.pdf'],
  },
  {
    id: 'd-2',
    booking_id: 'b-12',
    listing_title: 'Epson 4K Projector',
    raised_by: 'Bongani Zulu',
    raised_by_role: 'renter',
    against: 'Imani Mokoena',
    reason: 'Item not as described',
    description: "The projector listed as 4K only displays 1080p. Remote was also missing. I used it for one evening but it did not meet the spec promised in the listing.",
    amount_at_stake: 1500,
    status: 'pending_evidence',
    priority: 'high',
    created_at: '2026-06-02',
    evidence: ['screenshot_specs.png'],
  },
  {
    id: 'd-3',
    booking_id: 'b-1',
    listing_title: 'DJI Mavic 3 Pro Drone',
    raised_by: 'Imani Mokoena',
    raised_by_role: 'merchant',
    against: 'Sipho Dlamini',
    reason: 'Late return — 2 days overdue',
    description: 'Renter returned the drone 2 days after the agreed date without communication. Lost a booking because of this. Requesting 2 additional days of rental fee.',
    amount_at_stake: 1600,
    status: 'escalated',
    priority: 'high',
    created_at: '2026-06-05',
    evidence: ['whatsapp_screenshot.jpg', 'calendar_booking.png'],
  },
  {
    id: 'd-4',
    booking_id: 'b-7',
    listing_title: 'Trek Mountain Bike',
    raised_by: 'Priya Naidoo',
    raised_by_role: 'renter',
    against: 'Sarah Adams',
    reason: 'Deposit not returned',
    description: 'Rental ended 10 days ago and my deposit of R300 has not been returned. The bike was returned in perfect condition. Merchant has not responded to messages.',
    amount_at_stake: 300,
    status: 'resolved',
    priority: 'low',
    created_at: '2026-06-08',
    evidence: ['return_photo.jpg'],
    resolution: 'Deposit of R300 released to renter. Merchant warned about timely return confirmation.',
    resolved_in_favour_of: 'renter',
    resolved_at: '2026-06-10',
  },
]

// ─── Platform Stats ───────────────────────────────────────────────────────────

export const ADMIN_MOCK_STATS = {
  users: {
    total: 15,
    renters: 8,
    merchants: 6,
    admins: 1,
    affiliates: 6,
    suspended: 1,
    kyc_approved: 11,
    kyc_pending: 2,
    kyc_unverified: 1,
    kyc_rejected: 1,
  },
  listings: {
    total: 15,
    active: 10,
    paused: 2,
    draft: 1,
    flagged: 1,
  },
  bookings: {
    total: 12,
    pending: 3,
    active: 2,
    completed: 6,
    cancelled: 0,
    disputed: 2,
  },
  revenue: {
    gross_total: 25370,
    this_month: 12840,
    last_month: 8940,
    average_booking: 2114,
  },
  disputes: {
    total: 4,
    open: 2,
    pending_evidence: 1,
    escalated: 1,
    resolved: 1,
  },
  affiliates: {
    total: 7,
    active: 6,
    total_commission_paid: 11820,
    pending_payouts: 3510,
  },
}

// ─── Analytics Data (for recharts) ───────────────────────────────────────────

export const ANALYTICS_BOOKING_VOLUME = [
  { period: '2 Jan', bookings: 2,  revenue: 3200  },
  { period: '9 Jan', bookings: 4,  revenue: 7800  },
  { period: '16 Jan', bookings: 3, revenue: 5100  },
  { period: '23 Jan', bookings: 6, revenue: 11400 },
  { period: '30 Jan', bookings: 5, revenue: 9200  },
  { period: '6 Feb', bookings: 7,  revenue: 13600 },
  { period: '13 Feb', bookings: 8, revenue: 15200 },
  { period: '20 Feb', bookings: 6, revenue: 11800 },
  { period: '27 Feb', bookings: 9, revenue: 17100 },
  { period: '6 Mar', bookings: 11, revenue: 20900 },
  { period: '13 Mar', bookings: 8, revenue: 15600 },
  { period: '20 Mar', bookings: 12, revenue: 22800 },
  { period: '27 Mar', bookings: 10, revenue: 19000 },
  { period: '3 Apr', bookings: 14,  revenue: 26600 },
  { period: '10 Apr', bookings: 11, revenue: 20900 },
  { period: '17 Apr', bookings: 15, revenue: 28500 },
  { period: '24 Apr', bookings: 13, revenue: 24700 },
  { period: '1 May', bookings: 16,  revenue: 30400 },
  { period: '8 May', bookings: 18,  revenue: 34200 },
  { period: '15 May', bookings: 14, revenue: 26600 },
  { period: '22 May', bookings: 20, revenue: 38000 },
  { period: '29 May', bookings: 17, revenue: 32300 },
  { period: '5 Jun', bookings: 19,  revenue: 36100 },
  { period: '12 Jun', bookings: 22, revenue: 41800 },
]

export const ANALYTICS_CATEGORIES = [
  { name: 'Cameras',     bookings: 61, revenue: 98400 },
  { name: 'Drones',      bookings: 29, revenue: 68200 },
  { name: 'Audio',       bookings: 33, revenue: 38600 },
  { name: 'Camping',     bookings: 43, revenue: 24800 },
  { name: 'Power Tools', bookings: 21, revenue: 22100 },
  { name: 'Bicycles',    bookings: 12, revenue: 9600  },
  { name: 'Projectors',  bookings: 8,  revenue: 14400 },
  { name: 'Power',       bookings: 11, revenue: 19800 },
  { name: 'Garden',      bookings: 5,  revenue: 5400  },
  { name: 'Other',       bookings: 9,  revenue: 6200  },
]

export const ANALYTICS_TOP_MERCHANTS = [
  { name: 'Zanele Khumalo', revenue: 38200, bookings: 67 },
  { name: 'Imani Mokoena',  revenue: 29600, bookings: 42 },
  { name: 'Ayesha Patel',   revenue: 22400, bookings: 31 },
  { name: 'Kagiso Motsepe', revenue: 18900, bookings: 28 },
  { name: 'Sarah Adams',    revenue: 14200, bookings: 19 },
  { name: 'Lerato Sithole', revenue: 9800,  bookings: 14 },
]

export const ANALYTICS_CITIES = [
  { city: 'Johannesburg', bookings: 98,  revenue: 182400 },
  { city: 'Cape Town',    bookings: 64,  revenue: 119200 },
  { city: 'Durban',       bookings: 38,  revenue: 62800  },
  { city: 'Pretoria',     bookings: 21,  revenue: 34600  },
  { city: 'Port Elizabeth', bookings: 11, revenue: 18200 },
]
