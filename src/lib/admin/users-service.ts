import type { SupabaseClient } from '@supabase/supabase-js'
import { countAdminDisputesForUser } from '@/lib/admin/disputes-service'
import { getSupportCaseSummaryForUser, type AdminSupportCaseSummary } from '@/lib/admin/support-service'
import { profileScopeFilterValue, classifyProfile } from '@/lib/admin/data-scope'

/**
 * D3-C: every query in this file that lists/counts/looks up profiles is
 * scoped to confirmed real accounts only (profiles.data_classification
 * = 'real'), via the canonical D3-B contract rather than a duplicated
 * literal. No public/client-controlled scope parameter exists yet
 * (deliberately deferred) -- this phase hardcodes 'real', the only
 * scope Admin Customers/Merchants surface right now.
 */
const REAL_DATA_SCOPE = profileScopeFilterValue('real')

export interface AdminUserFilters {
  search?: string
  role?: string
  kycStatus?: string
  accountStatus?: string
  limit?: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AdminUserRow {
  id: string
  fullName: string | null
  displayName: string | null
  role: string
  kycStatus: string
  accountStatus: string
  unityScore: number
  createdAt: string
}

const DEFAULT_LIMIT = 100

/**
 * List users for the admin table. Never selects id-document fields —
 * those stay behind the dedicated identity-verification review page
 * (src/app/admin/verifications/[id]/page.tsx), which is the only place
 * sensitive document metadata is ever returned to an admin client.
 *
 * Search targets: name (full_name/display_name, substring) and phone
 * (substring) via `profiles` directly, plus an exact user-id match when
 * the query is itself a UUID. Deliberately does NOT search by email:
 * `profiles` never stores email (confirmed -- see getAdminUserDetail's
 * own comment), and Supabase's Admin Auth API (`auth.admin.listUsers`)
 * takes no email filter parameter at all (confirmed directly from the
 * installed @supabase/auth-js SDK's own type definitions) -- the only
 * way to "search by email" would be paging through every auth user and
 * filtering client-side, which is exactly the uncontrolled bulk
 * auth-user enumeration this phase was told not to build. If email
 * search becomes a real operational need, it requires its own narrow,
 * rate-limited phase -- not a silent workaround here.
 */
export async function listAdminUsers(admin: SupabaseClient, filters: AdminUserFilters): Promise<AdminUserRow[]> {
  let query = admin
    .from('profiles')
    .select('id, full_name, display_name, role, kyc_status, account_status, unity_score, created_at')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (REAL_DATA_SCOPE) query = query.eq('data_classification', REAL_DATA_SCOPE)
  if (filters.role && filters.role !== 'all') query = query.eq('role', filters.role)
  if (filters.kycStatus && filters.kycStatus !== 'all') query = query.eq('kyc_status', filters.kycStatus)
  if (filters.accountStatus && filters.accountStatus !== 'all') query = query.eq('account_status', filters.accountStatus)
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim()
    if (UUID_RE.test(q)) {
      query = query.eq('id', q)
    } else {
      query = query.or(`full_name.ilike.%${q}%,display_name.ilike.%${q}%,phone.ilike.%${q}%`)
    }
  }

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    displayName: row.display_name,
    role: row.role,
    kycStatus: row.kyc_status,
    accountStatus: row.account_status,
    unityScore: row.unity_score,
    createdAt: row.created_at,
  }))
}

export interface AdminUserDetail {
  profile: {
    id: string
    fullName: string | null
    displayName: string | null
    phone: string | null
    role: string
    kycStatus: string
    accountStatus: string
    statusReason: string | null
    statusChangedAt: string | null
    unityScore: number
    createdAt: string
  }
  verification: { status: string; reviewedAt: string | null } | null
  listingsCount: number
  bookingsAsRenterCount: number
  bookingsAsMerchantCount: number
  /** ADMIN-CONTROL-CENTRE-BATCH-A1: real count via disputes-service's countAdminDisputesForUser -- replaces the prior permanently-hardcoded null. */
  disputeCount: number
  ordersCount: number
  barterCount: number
  rentToBuyCount: number
  lookingForCount: number
  reviewsCount: number
  /** ADMIN-CONTROL-CENTRE-BATCH-A2: Support Centre summary -- open cases where this profile is the customer or merchant, plus the most recent few (any status). */
  openSupportCaseCount: number
  recentSupportCases: AdminSupportCaseSummary[]
  accountHistory: Array<{
    id: string
    actionType: string
    previousStatus: string
    newStatus: string
    userReason: string | null
    internalNote: string | null
    adminId: string
    createdAt: string
  }>
  notes: Array<{ id: string; note: string; adminId: string; createdAt: string }>
}

export async function getAdminUserDetail(admin: SupabaseClient, userId: string): Promise<AdminUserDetail | null> {
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, full_name, display_name, phone, role, kyc_status, account_status, status_reason, status_changed_at, unity_score, created_at, data_classification')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) throw profileError
  if (!profile) return null
  // D3-C: this detail lookup is shared by both the Customers and
  // Merchants 360 views (a merchant is just profiles.role IN
  // ('merchant','both')) -- a known test/unknown UUID must not bypass
  // the list-level real-data scope just because the caller already
  // knows its id. Reported as "not found" rather than a distinguishable
  // error, matching how the route already treats a missing row.
  if (REAL_DATA_SCOPE && classifyProfile(profile) !== REAL_DATA_SCOPE) return null

  const [
    { data: verification },
    { count: listingsCount },
    { count: renterCount },
    { count: merchantCount },
    disputeCount,
    { count: ordersCount },
    { count: barterCount },
    { count: rentToBuyCount },
    { count: lookingForCount },
    { count: reviewsCount },
    supportCaseSummary,
    { data: history },
    { data: notes },
  ] = await Promise.all([
    admin.from('identity_verifications').select('status, reviewed_at').eq('user_id', userId).maybeSingle(),
    admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', userId),
    admin.from('bookings').select('id', { count: 'exact', head: true }).eq('renter_id', userId),
    admin.from('bookings').select('id', { count: 'exact', head: true }).eq('merchant_id', userId),
    countAdminDisputesForUser(admin, userId),
    admin.from('orders').select('id', { count: 'exact', head: true }).or(`buyer_id.eq.${userId},seller_id.eq.${userId}`),
    admin.from('barter_agreements').select('id', { count: 'exact', head: true }).or(`party_a_id.eq.${userId},party_b_id.eq.${userId}`),
    admin.from('rent_to_buy_agreements').select('id', { count: 'exact', head: true }).or(`merchant_id.eq.${userId},customer_id.eq.${userId}`),
    admin.from('marketplace_requests').select('id', { count: 'exact', head: true }).eq('requester_id', userId),
    admin.from('reviews_v2').select('id', { count: 'exact', head: true }).or(`reviewer_id.eq.${userId},reviewee_id.eq.${userId}`),
    getSupportCaseSummaryForUser(admin, userId),
    admin.from('user_account_history').select('id, action_type, previous_status, new_status, user_reason, internal_note, admin_id, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('admin_notes').select('id, note, admin_id, created_at').eq('entity_type', 'user').eq('entity_id', userId).order('created_at', { ascending: false }),
  ])

  return {
    profile: {
      id: profile.id,
      fullName: profile.full_name,
      displayName: profile.display_name,
      phone: profile.phone,
      role: profile.role,
      kycStatus: profile.kyc_status,
      accountStatus: profile.account_status,
      statusReason: profile.status_reason,
      statusChangedAt: profile.status_changed_at,
      unityScore: profile.unity_score,
      createdAt: profile.created_at,
    },
    verification: verification ? { status: verification.status, reviewedAt: verification.reviewed_at } : null,
    listingsCount: listingsCount ?? 0,
    bookingsAsRenterCount: renterCount ?? 0,
    bookingsAsMerchantCount: merchantCount ?? 0,
    disputeCount,
    ordersCount: ordersCount ?? 0,
    barterCount: barterCount ?? 0,
    rentToBuyCount: rentToBuyCount ?? 0,
    lookingForCount: lookingForCount ?? 0,
    reviewsCount: reviewsCount ?? 0,
    openSupportCaseCount: supportCaseSummary.openCount,
    recentSupportCases: supportCaseSummary.recent,
    accountHistory: (history ?? []).map((h) => ({
      id: h.id,
      actionType: h.action_type,
      previousStatus: h.previous_status,
      newStatus: h.new_status,
      userReason: h.user_reason,
      internalNote: h.internal_note,
      adminId: h.admin_id,
      createdAt: h.created_at,
    })),
    notes: (notes ?? []).map((n) => ({ id: n.id, note: n.note, adminId: n.admin_id, createdAt: n.created_at })),
  }
}

export async function setUserAccountStatus(
  admin: SupabaseClient,
  userId: string,
  adminId: string,
  action: 'restricted' | 'suspended' | 'restored',
  userReason: string | null,
  internalNote: string | null,
  idempotencyKey: string | undefined
) {
  return admin.rpc('set_user_account_status', {
    p_user_id: userId,
    p_admin_id: adminId,
    p_action: action,
    p_user_reason: userReason ?? null,
    p_internal_note: internalNote ?? null,
    p_idempotency_key: idempotencyKey ?? null,
  })
}

export async function addAdminNote(
  admin: SupabaseClient,
  entityType: 'user' | 'listing' | 'booking',
  entityId: string,
  adminId: string,
  note: string,
  idempotencyKey: string | undefined
) {
  return admin.rpc('add_admin_note', {
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_admin_id: adminId,
    p_note: note,
    p_idempotency_key: idempotencyKey ?? null,
  })
}

export interface RealUserOverviewCounts {
  totalUsers: number
  activeUsers: number
  merchants: number
  renters: number
  suspendedUsers: number
  restrictedUsers: number
}

/**
 * D3-C: the 6 account-derived Admin Overview metrics (Total/Active
 * users, Merchants, Renters, Restricted, Suspended), scoped to
 * confirmed real profiles only. get_admin_overview_stats() (the RPC
 * both src/app/admin/page.tsx and /api/admin/overview otherwise rely
 * on for every Overview number) counts the whole `profiles` table with
 * no classification awareness at all, and this phase does not create a
 * migration to edit that RPC in place -- so these 6 fields are computed
 * here, server-side, and used to OVERRIDE the RPC's mixed-population
 * values for exactly these 6 keys. Every other Overview metric
 * (listings, bookings, barter, orders, affiliate, payouts,
 * subscriptions, commissions, escrow, RTB, review queues, financial
 * workflows, email failures) belongs to a domain this phase does not
 * touch (Listings/Transactions/Finance/Advertising/Support/Trust &
 * Safety) and is left exactly as the RPC reports it, unscoped, until
 * that domain's own future D3 phase.
 */
export async function getRealUserOverviewCounts(admin: SupabaseClient): Promise<RealUserOverviewCounts> {
  const scoped = () => {
    const q = admin.from('profiles').select('id', { count: 'exact', head: true })
    return REAL_DATA_SCOPE ? q.eq('data_classification', REAL_DATA_SCOPE) : q
  }

  const [{ count: totalUsers }, { count: activeUsers }, { count: merchants }, { count: renters }, { count: suspendedUsers }, { count: restrictedUsers }] =
    await Promise.all([
      scoped(),
      scoped().eq('account_status', 'active'),
      scoped().in('role', ['merchant', 'both']),
      scoped().in('role', ['renter', 'both']),
      scoped().eq('account_status', 'suspended'),
      scoped().eq('account_status', 'restricted'),
    ])

  return {
    totalUsers: totalUsers ?? 0,
    activeUsers: activeUsers ?? 0,
    merchants: merchants ?? 0,
    renters: renters ?? 0,
    suspendedUsers: suspendedUsers ?? 0,
    restrictedUsers: restrictedUsers ?? 0,
  }
}
