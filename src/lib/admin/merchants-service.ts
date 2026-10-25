import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AdminMerchantFilters {
  search?: string
  kycStatus?: string
  accountStatus?: string
  limit?: number
}

export interface AdminMerchantRow {
  id: string
  fullName: string | null
  displayName: string | null
  role: string
  kycStatus: string
  accountStatus: string
  unityScore: number
  createdAt: string
  activeListingCount: number
  pendingOwnershipCount: number
  /**
   * A single unambiguous signal (at least one FAILED payout on record) --
   * deliberately not a full re-implementation of exceptions-service's
   * overdue-threshold logic, which already has its own documented
   * threshold and its own screen (/admin/exceptions). Treat this as "worth
   * a second look", not as a complete financial-health summary.
   */
  hasFailedPayout: boolean
  subscriptionPlanId: string
}

/**
 * A merchant is not a separate data model -- it's `profiles.role IN
 * ('merchant', 'both')`, viewed through the same `profiles` table every
 * other admin user query uses (confirmed by the admin-control-centre
 * design review: no business-info columns like company name/VAT exist
 * in the schema, and none are added here). Per-merchant extra counts are
 * fetched as a FIXED number of additional batched queries (one or two
 * per metric, each `.in(merchantIds)`-bounded), never one query per row.
 */
export async function listAdminMerchants(admin: SupabaseClient, filters: AdminMerchantFilters): Promise<AdminMerchantRow[]> {
  let query = admin
    .from('profiles')
    .select('id, full_name, display_name, role, kyc_status, account_status, unity_score, created_at')
    .in('role', ['merchant', 'both'])
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.kycStatus && filters.kycStatus !== 'all') query = query.eq('kyc_status', filters.kycStatus)
  if (filters.accountStatus && filters.accountStatus !== 'all') query = query.eq('account_status', filters.accountStatus)
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim()
    // Same no-email-search limitation and rationale as listAdminUsers.
    if (UUID_RE.test(q)) {
      query = query.eq('id', q)
    } else {
      query = query.or(`full_name.ilike.%${q}%,display_name.ilike.%${q}%,phone.ilike.%${q}%`)
    }
  }

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const merchantIds = rows.map((r) => r.id)

  // Every listing (any status) owned by this page's merchants, fetched
  // once -- bounded by merchant_id, never unbounded platform-wide. Used
  // both for the active-listing count and to resolve
  // listing_ownership_verification rows (which have no merchant_id
  // column of their own) back to a merchant.
  const { data: allListingRows } = await admin.from('listings').select('id, merchant_id, status').in('merchant_id', merchantIds)
  const listingIds = (allListingRows ?? []).map((l) => l.id)

  const [{ data: ownershipRows }, { data: payoutRows }, { data: subRows }] = await Promise.all([
    listingIds.length
      ? admin.from('listing_ownership_verification').select('listing_id, status').in('listing_id', listingIds).in('status', ['pending', 'under_review', 'additional_evidence_required'])
      : Promise.resolve({ data: [] }),
    admin.from('merchant_payouts').select('merchant_id').eq('status', 'failed').in('merchant_id', merchantIds),
    admin.from('merchant_subscriptions').select('merchant_id, current_plan_id').in('merchant_id', merchantIds),
  ])

  const activeListingCountByMerchant = new Map<string, number>()
  const listingIdToMerchantId = new Map<string, string>()
  for (const l of allListingRows ?? []) {
    listingIdToMerchantId.set(l.id, l.merchant_id)
    if (l.status === 'active') activeListingCountByMerchant.set(l.merchant_id, (activeListingCountByMerchant.get(l.merchant_id) ?? 0) + 1)
  }

  const pendingOwnershipCountByMerchant = new Map<string, number>()
  for (const o of ownershipRows ?? []) {
    const merchantId = listingIdToMerchantId.get(o.listing_id)
    if (merchantId) pendingOwnershipCountByMerchant.set(merchantId, (pendingOwnershipCountByMerchant.get(merchantId) ?? 0) + 1)
  }

  const failedPayoutMerchantIds = new Set((payoutRows ?? []).map((p) => p.merchant_id))
  const planByMerchant = new Map((subRows ?? []).map((s) => [s.merchant_id, s.current_plan_id]))

  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    displayName: r.display_name,
    role: r.role,
    kycStatus: r.kyc_status,
    accountStatus: r.account_status,
    unityScore: r.unity_score,
    createdAt: r.created_at,
    activeListingCount: activeListingCountByMerchant.get(r.id) ?? 0,
    pendingOwnershipCount: pendingOwnershipCountByMerchant.get(r.id) ?? 0,
    hasFailedPayout: failedPayoutMerchantIds.has(r.id),
    subscriptionPlanId: planByMerchant.get(r.id) ?? 'starter',
  }))
}
