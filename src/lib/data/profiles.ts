import type { SupabaseClient } from '@supabase/supabase-js'
import { MOCK_PROFILES, MOCK_CURRENT_PROFILE, IS_MOCK_MODE } from '@/lib/mock/data'

export async function getServerUser() {
  if (IS_MOCK_MODE) {
    return { user: null, profile: null }
  }

  try {
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    if (!supabase) return { user: null, profile: null }

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { user: null, profile: null }

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    return { user, profile }
  } catch {
    return { user: null, profile: null }
  }
}

// ============================================================
// Clickable Customer Profiles -- public profile data boundary.
// ============================================================
// `profiles` itself has no column-level RLS (its "public read" policy
// is row-level `using (true)`, granting every column once a row is
// visible at all -- see docs/CLICKABLE_PROFILES.md). Every function
// below is a deliberate, explicit-column allowlist boundary -- never
// `select('*')` on a client-facing path. This is the ONLY place a
// stranger's profile data may be read for public display.

export interface PublicProfileCore {
  id: string
  displayName: string
  avatarUrl: string | null
  isMerchant: boolean
  /** true only when the CURRENT, live kyc_status is 'approved' -- never the raw enum value. */
  isVerified: boolean
  memberSince: string
  reviewCount: number
  /** null when reviewCount is 0 -- never substituted with a default/fabricated value. */
  publicRating: number | null
  completedTransactionCount: number
}

export type PublicProfileResult =
  | { status: 'not_found' }
  /** account_status = 'suspended' -- a neutral unavailable state, no private/marketplace data included. */
  | { status: 'unavailable' }
  | { status: 'ok'; profile: PublicProfileCore }

export function displayNameOf(row: { display_name: string | null; full_name: string | null }): string {
  return row.display_name ?? row.full_name ?? 'Unity Member'
}

/**
 * The public profile core -- exactly the allowlisted fields a stranger
 * may see. `account_status`/`phone`/`is_affiliate`/`affiliate_code`/
 * `status_reason`/`status_changed_at`/`status_changed_by` are never
 * RETURNED here (not merely omitted from the client-facing surface --
 * this function's own return type structurally cannot carry them).
 *
 * This function DOES read raw `kyc_status`/`account_status` internally
 * (to derive `isVerified` and the suspended-gate), which the public
 * `public_profiles` view deliberately does not expose -- so it uses a
 * trusted, server-only SERVICE-ROLE client, not the anon/authenticated
 * session client. This is the one place in the app that legitimately
 * needs to see those two raw columns for ANY profile id in order to
 * compute a SAFE derived value, then discards them before returning.
 * See supabase/migrations/20260831000001_profiles_privacy_boundary.sql.
 */
export async function getPublicProfile(id: string): Promise<PublicProfileResult> {
  if (IS_MOCK_MODE) {
    const p = MOCK_PROFILES.find((m) => m.id === id)
    if (!p) return { status: 'not_found' }
    return {
      status: 'ok',
      profile: {
        id: p.id,
        displayName: displayNameOf(p),
        avatarUrl: p.avatar_url,
        isMerchant: p.role === 'merchant' || p.role === 'both',
        isVerified: p.kyc_status === 'approved',
        memberSince: p.created_at,
        reviewCount: 0,
        publicRating: null,
        completedTransactionCount: 0,
      },
    }
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return { status: 'not_found' }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const supabase = createServiceClient(url, serviceKey)

  const { data: row } = await supabase
    .from('profiles')
    .select('id, display_name, full_name, avatar_url, role, kyc_status, unity_score, account_status, created_at')
    .eq('id', id)
    .maybeSingle()

  if (!row) return { status: 'not_found' }
  if (row.account_status === 'suspended') return { status: 'unavailable' }

  const [{ count: reviewCount }, completedTransactionCount] = await Promise.all([
    supabase.from('reviews').select('id', { count: 'exact', head: true }).eq('reviewee_id', id),
    getCompletedTransactionCount(supabase, id),
  ])

  return {
    status: 'ok',
    profile: {
      id: row.id,
      displayName: displayNameOf(row),
      avatarUrl: row.avatar_url,
      isMerchant: row.role === 'merchant' || row.role === 'both',
      isVerified: row.kyc_status === 'approved',
      memberSince: row.created_at,
      reviewCount: reviewCount ?? 0,
      publicRating: reviewCount && reviewCount > 0 ? row.unity_score : null,
      completedTransactionCount,
    },
  }
}

/**
 * Sums genuinely completed transactions across all four domains,
 * counting the profile as either side (merchant/customer, buyer/
 * seller, party_a/party_b). Only each domain's own real terminal
 * status counts -- never cancelled/draft/failed/pending/disputed/
 * offers-only. No cross-domain business-policy invention: this is a
 * plain count of rows already known to be terminal by each domain's
 * own established status model (orders: 'delivered'; bookings/barter/
 * RTB: 'completed').
 */
async function getCompletedTransactionCount(supabase: SupabaseClient, profileId: string): Promise<number> {
  const [orders, bookings, barter, rtb] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'delivered').or(`buyer_id.eq.${profileId},seller_id.eq.${profileId}`),
    supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'completed').or(`renter_id.eq.${profileId},merchant_id.eq.${profileId}`),
    supabase.from('barter_agreements').select('id', { count: 'exact', head: true }).eq('status', 'completed').or(`party_a_id.eq.${profileId},party_b_id.eq.${profileId}`),
    supabase.from('rent_to_buy_agreements').select('id', { count: 'exact', head: true }).eq('status', 'completed').or(`merchant_id.eq.${profileId},customer_id.eq.${profileId}`),
  ])
  return (orders.count ?? 0) + (bookings.count ?? 0) + (barter.count ?? 0) + (rtb.count ?? 0)
}

export interface PublicProfileListing {
  id: string
  title: string
  listing_type: 'rental' | 'sale' | 'both'
  daily_rate: number | null
  sale_price: number | null
  category: string
  media: { url: string }[]
}

/**
 * Current, publicly-eligible Available listings for this profile —
 * the exact same status='active' + is_test=false predicate as the main
 * marketplace browse query (getListings()). Never reuses
 * getListingsByMerchant() as-is for this purpose — that function
 * intentionally omits a status filter for the owner's own private
 * dashboard (drafts included) and would leak them here.
 */
export async function getPublicProfileListings(profileId: string, { limit = 12, offset = 0 }: { limit?: number; offset?: number } = {}): Promise<{ listings: PublicProfileListing[]; total: number }> {
  if (IS_MOCK_MODE) {
    const all = MOCK_PROFILES.length ? [] : [] // no mock fixture wiring needed — mock mode has no dedicated profile-listing fixtures
    return { listings: all, total: 0 }
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return { listings: [], total: 0 }

  const { data, count } = await supabase
    .from('listings')
    .select('id, title, listing_type, daily_rate, sale_price, category, media:listing_media(url)', { count: 'exact' })
    .eq('merchant_id', profileId)
    .eq('status', 'active')
    .eq('is_test', false)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  return { listings: (data as PublicProfileListing[] | null) ?? [], total: count ?? 0 }
}

export interface PublicProfileRequest {
  id: string
  transaction_type: string
  title: string
  category: string | null
  budget_min: number | null
  budget_max: number | null
  currency: string | null
  created_at: string
}

/**
 * Current, publicly-eligible Looking For requests for this profile —
 * mirrors getMarketplaceRequests()'s exact status/is_test predicate.
 */
export async function getPublicProfileRequests(profileId: string, { limit = 12, offset = 0 }: { limit?: number; offset?: number } = {}): Promise<{ requests: PublicProfileRequest[]; total: number }> {
  if (IS_MOCK_MODE) return { requests: [], total: 0 }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return { requests: [], total: 0 }

  const { data, count } = await supabase
    .from('marketplace_requests')
    .select('id, transaction_type, title, category, budget_min, budget_max, currency, created_at', { count: 'exact' })
    .eq('requester_id', profileId)
    .eq('is_test', false)
    .in('status', ['active', 'offers_received'])
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  return { requests: (data as PublicProfileRequest[] | null) ?? [], total: count ?? 0 }
}

export interface PublicProfileSkillTaskPost {
  id: string
  kind: 'skill' | 'task'
  direction: 'available' | 'looking_for'
  title: string
  description: string
  category_id: string | null
  delivery_mode: 'remote' | 'in_person' | 'either'
  province: string | null
  city: string | null
  wants_item: boolean
  wants_skill: boolean
  wants_task: boolean
  wants_cash_adjustment: boolean
  created_at: string
}

/**
 * Skills + Tasks under Barter -- public profile Skills/Tasks tabs.
 * Reads ONLY `barter_skill_task_public_posts` (never the base
 * `barter_skill_task_posts` table) -- the view already bakes in the
 * D1/R5-2 public-eligibility predicate (active Available, or
 * active/offers_received Looking For, is_test=false), so an ordinary
 * stranger viewing this profile can never see a draft/paused/
 * suspended/matched/closed/archived post through this path. See
 * supabase/migrations/20260901000002_skills_tasks_barter_posts_schema.sql.
 */
async function getPublicProfileSkillTaskPosts(
  profileId: string,
  kind: 'skill' | 'task',
  direction: 'available' | 'looking_for',
  { limit = 12, offset = 0 }: { limit?: number; offset?: number } = {}
): Promise<{ posts: PublicProfileSkillTaskPost[]; total: number }> {
  if (IS_MOCK_MODE) return { posts: [], total: 0 }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return { posts: [], total: 0 }

  const { data, count } = await supabase
    .from('barter_skill_task_public_posts')
    .select('id, kind, direction, title, description, category_id, delivery_mode, province, city, wants_item, wants_skill, wants_task, wants_cash_adjustment, created_at', { count: 'exact' })
    .eq('owner_id', profileId)
    .eq('kind', kind)
    .eq('direction', direction)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  return { posts: (data as PublicProfileSkillTaskPost[] | null) ?? [], total: count ?? 0 }
}

/** Available/Looking-For sub-view for this profile's public Skills tab. */
export function getPublicProfileSkills(profileId: string, direction: 'available' | 'looking_for', opts?: { limit?: number; offset?: number }) {
  return getPublicProfileSkillTaskPosts(profileId, 'skill', direction, opts)
}

/** Available/Looking-For sub-view for this profile's public Tasks tab. */
export function getPublicProfileTasks(profileId: string, direction: 'available' | 'looking_for', opts?: { limit?: number; offset?: number }) {
  return getPublicProfileSkillTaskPosts(profileId, 'task', direction, opts)
}

export interface PublicProfileReview {
  id: string
  rating: number
  comment: string | null
  created_at: string
  reviewer: { id: string; displayName: string; avatarUrl: string | null } | null
}

/** Paginated, genuine reviews only -- never fabricated, never test data mixed in (reviews carry no is_test flag; see docs/CLICKABLE_PROFILES.md known limitation). */
export async function getPublicProfileReviews(revieweeId: string, { limit = 10, offset = 0 }: { limit?: number; offset?: number } = {}): Promise<{ reviews: PublicProfileReview[]; total: number }> {
  if (IS_MOCK_MODE) return { reviews: [], total: 0 }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return { reviews: [], total: 0 }

  // No `profiles!reviews_reviewer_id_fkey(...)` embed -- `profiles` is
  // no longer directly SELECT-able for another user's row (see
  // supabase/migrations/20260831000001_profiles_privacy_boundary.sql).
  // Reviewer identity is a separate batched lookup against the public
  // identity view instead.
  const { data, count } = await supabase
    .from('reviews')
    .select('id, rating, comment, created_at, reviewer_id', { count: 'exact' })
    .eq('reviewee_id', revieweeId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const rows = (data ?? []) as Array<{ id: string; rating: number; comment: string | null; created_at: string; reviewer_id: string }>
  const reviewerIds = [...new Set(rows.map((r) => r.reviewer_id))]
  const { data: reviewers } = reviewerIds.length
    ? await supabase.from('public_profiles').select('id, display_name, full_name, avatar_url').in('id', reviewerIds)
    : { data: [] as { id: string; display_name: string | null; full_name: string | null; avatar_url: string | null }[] }
  const reviewerById = new Map((reviewers ?? []).map((r) => [r.id, r]))

  const reviews = rows.map((r) => {
    const reviewer = reviewerById.get(r.reviewer_id)
    return {
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      created_at: r.created_at,
      reviewer: reviewer ? { id: reviewer.id, displayName: displayNameOf(reviewer), avatarUrl: reviewer.avatar_url } : null,
    }
  })

  return { reviews, total: count ?? 0 }
}

export { MOCK_CURRENT_PROFILE }
