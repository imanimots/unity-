import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyProfile, classifyEntityWithOwners } from '@/lib/admin/data-scope'

const DEFAULT_LIMIT = 100

export interface AdminAffiliateRow {
  id: string
  affiliateCode: string | null
  name: string | null
  accountStatus: string | null
  attributionCount: number
  commissionCount: number
  pendingCount: number
  paidAmount: number
  createdAt: string
}

export interface AdminAffiliateFilters {
  search?: string
  limit?: number
}

/**
 * Mirrors listAdminOrders' exact shape: one base query + Promise.all of
 * related-table lookups + in-memory joins.
 *
 * D3-E: real requires the affiliate's own profile positively real --
 * this is a direct `profiles` query (the affiliate roster IS a view
 * over `profiles`, same relationship as merchants in D3-C), so the
 * filter is a plain `.eq()`, not an embedded join.
 */
export async function listAdminAffiliates(admin: SupabaseClient, filters: AdminAffiliateFilters): Promise<AdminAffiliateRow[]> {
  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, full_name, display_name, affiliate_code, account_status, created_at')
    .eq('is_affiliate', true)
    .eq('data_classification', 'real')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (error) throw error
  if (!profiles || profiles.length === 0) return []

  const affiliateIds = profiles.map((p) => p.id)

  const [{ data: attributions }, { data: commissions }] = await Promise.all([
    admin.from('affiliate_attributions').select('affiliate_id').in('affiliate_id', affiliateIds),
    admin.from('affiliate_commissions').select('affiliate_id, status, commission_amount').in('affiliate_id', affiliateIds),
  ])

  const attributionCountByAffiliate = new Map<string, number>()
  for (const a of attributions ?? []) {
    attributionCountByAffiliate.set(a.affiliate_id, (attributionCountByAffiliate.get(a.affiliate_id) ?? 0) + 1)
  }

  const commissionCountByAffiliate = new Map<string, number>()
  const pendingCountByAffiliate = new Map<string, number>()
  const paidAmountByAffiliate = new Map<string, number>()
  for (const c of commissions ?? []) {
    commissionCountByAffiliate.set(c.affiliate_id, (commissionCountByAffiliate.get(c.affiliate_id) ?? 0) + 1)
    if (c.status === 'pending' || c.status === 'held' || c.status === 'approved' || c.status === 'payout_queued' || c.status === 'processing') {
      pendingCountByAffiliate.set(c.affiliate_id, (pendingCountByAffiliate.get(c.affiliate_id) ?? 0) + 1)
    }
    if (c.status === 'paid') {
      paidAmountByAffiliate.set(c.affiliate_id, (paidAmountByAffiliate.get(c.affiliate_id) ?? 0) + c.commission_amount)
    }
  }

  let results: AdminAffiliateRow[] = profiles.map((p) => ({
    id: p.id,
    affiliateCode: p.affiliate_code,
    name: p.full_name ?? p.display_name,
    accountStatus: p.account_status,
    attributionCount: attributionCountByAffiliate.get(p.id) ?? 0,
    commissionCount: commissionCountByAffiliate.get(p.id) ?? 0,
    pendingCount: pendingCountByAffiliate.get(p.id) ?? 0,
    paidAmount: paidAmountByAffiliate.get(p.id) ?? 0,
    createdAt: p.created_at,
  }))

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    results = results.filter((a) => (a.affiliateCode ?? '').toLowerCase().includes(q) || (a.name ?? '').toLowerCase().includes(q))
  }

  return results
}

export interface AdminAffiliateDetail {
  affiliate: AdminAffiliateRow
  attributions: Record<string, unknown>[]
  commissions: Record<string, unknown>[]
}

export async function getAdminAffiliateDetail(admin: SupabaseClient, affiliateId: string): Promise<AdminAffiliateDetail | null> {
  const { data: profile, error } = await admin
    .from('profiles')
    .select('id, full_name, display_name, affiliate_code, account_status, created_at, data_classification')
    .eq('id', affiliateId)
    .eq('is_affiliate', true)
    .maybeSingle()

  if (error) throw error
  if (!profile) return null
  // D3-E: a known test/unknown-classified affiliate id must not load
  // as an ordinary Real Data affiliate detail -- checked before the
  // attributions/commissions fetches below.
  if (classifyProfile(profile) !== 'real') return null

  const [{ data: attributions }, { data: commissions }] = await Promise.all([
    admin.from('affiliate_attributions').select('*, listings(title)').eq('affiliate_id', affiliateId).order('attributed_at', { ascending: false }),
    admin.from('affiliate_commissions').select('*, listings(title)').eq('affiliate_id', affiliateId).order('created_at', { ascending: false }),
  ])

  const commissionRows = commissions ?? []
  const pendingCount = commissionRows.filter((c) => ['pending', 'held', 'approved', 'payout_queued', 'processing'].includes(c.status)).length
  const paidAmount = commissionRows.filter((c) => c.status === 'paid').reduce((sum, c) => sum + c.commission_amount, 0)

  return {
    affiliate: {
      id: profile.id,
      affiliateCode: profile.affiliate_code,
      name: profile.full_name ?? profile.display_name,
      accountStatus: profile.account_status,
      attributionCount: (attributions ?? []).length,
      commissionCount: commissionRows.length,
      pendingCount,
      paidAmount,
      createdAt: profile.created_at,
    },
    attributions: attributions ?? [],
    commissions: commissionRows,
  }
}

export interface AdminCommissionRow {
  id: string
  transactionType: string
  status: string
  affiliateId: string
  affiliateName: string | null
  merchantId: string
  merchantName: string | null
  listingId: string
  listingTitle: string | null
  reference: string | null
  commissionAmount: number
  currency: string
  createdAt: string
  approvedAt: string | null
  paidAt: string | null
  hasRefundOrDispute: boolean
}

export interface AdminCommissionFilters {
  affiliateId?: string
  merchantId?: string
  listingId?: string
  transactionType?: string
  status?: string
  search?: string
  limit?: number
}

/**
 * D3-E: unlike unity_commissions, affiliate_commissions has every
 * required actor as a DIRECT column -- affiliate_id, merchant_id, AND
 * referred_user_id (the referred buyer/renter) all reference profiles
 * directly, with no need to trace through order_id/booking_id for
 * provenance. Real requires all three positively real AND the linked
 * listing not test -- scoped at the database level via inner-joined,
 * aliased profiles plus an inner-joined listing, before `.limit()`.
 */
export async function listAdminAffiliateCommissions(admin: SupabaseClient, filters: AdminCommissionFilters): Promise<AdminCommissionRow[]> {
  let query = admin
    .from('affiliate_commissions')
    .select(
      `id, transaction_type, status, affiliate_id, merchant_id, referred_user_id, listing_id, order_id, booking_id, payment_id, commission_amount, currency, created_at, approved_at, payout_confirmed_at,
      listings!inner(title, is_test),
      affiliate_profile:profiles!affiliate_commissions_affiliate_id_fkey!inner(data_classification),
      merchant_profile:profiles!affiliate_commissions_merchant_id_fkey!inner(data_classification),
      referred_profile:profiles!affiliate_commissions_referred_user_id_fkey!inner(data_classification)`
    )
    .eq('listings.is_test', false)
    .eq('affiliate_profile.data_classification', 'real')
    .eq('merchant_profile.data_classification', 'real')
    .eq('referred_profile.data_classification', 'real')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.affiliateId) query = query.eq('affiliate_id', filters.affiliateId)
  if (filters.merchantId) query = query.eq('merchant_id', filters.merchantId)
  if (filters.listingId) query = query.eq('listing_id', filters.listingId)
  if (filters.transactionType && filters.transactionType !== 'all') query = query.eq('transaction_type', filters.transactionType)
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const userIds = Array.from(new Set(rows.flatMap((r) => [r.affiliate_id, r.merchant_id])))
  const paymentIds = rows.map((r) => r.payment_id)

  const [{ data: profiles }, { data: payments }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name').in('id', userIds),
    admin.from('payments').select('id, status').in('id', paymentIds),
  ])

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const paymentStatusById = new Map((payments ?? []).map((p) => [p.id, p.status]))

  let results: AdminCommissionRow[] = rows.map((r) => ({
    id: r.id,
    transactionType: r.transaction_type,
    status: r.status,
    affiliateId: r.affiliate_id,
    affiliateName: nameById.get(r.affiliate_id) ?? null,
    merchantId: r.merchant_id,
    merchantName: nameById.get(r.merchant_id) ?? null,
    listingId: r.listing_id,
    listingTitle: (r.listings as unknown as { title: string } | null)?.title ?? null,
    reference: r.order_id ?? r.booking_id,
    commissionAmount: r.commission_amount,
    currency: r.currency,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    paidAt: r.payout_confirmed_at,
    hasRefundOrDispute: ['refunded', 'partially_refunded', 'chargeback'].includes(paymentStatusById.get(r.payment_id) ?? ''),
  }))

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    results = results.filter(
      (c) =>
        (c.affiliateName ?? '').toLowerCase().includes(q) ||
        (c.merchantName ?? '').toLowerCase().includes(q) ||
        (c.listingTitle ?? '').toLowerCase().includes(q) ||
        (c.reference ?? '').toLowerCase().includes(q)
    )
  }

  return results
}

export interface AdminCommissionDetail {
  commission: Record<string, unknown>
  history: Record<string, unknown>[]
  adjustments: Record<string, unknown>[]
  payment: Record<string, unknown> | null
  affiliateName: string | null
  merchantName: string | null
  listingTitle: string | null
}

export async function getAdminAffiliateCommissionDetail(admin: SupabaseClient, commissionId: string): Promise<AdminCommissionDetail | null> {
  const { data: commission, error } = await admin.from('affiliate_commissions').select('*').eq('id', commissionId).maybeSingle()
  if (error) throw error
  if (!commission) return null

  const [{ data: scopeProfiles }, { data: scopeListing }] = await Promise.all([
    admin.from('profiles').select('id, data_classification').in('id', [commission.affiliate_id, commission.merchant_id, commission.referred_user_id]),
    admin.from('listings').select('is_test').eq('id', commission.listing_id).maybeSingle(),
  ])
  const scopeAffiliate = scopeProfiles?.find((p) => p.id === commission.affiliate_id)
  const scopeMerchant = scopeProfiles?.find((p) => p.id === commission.merchant_id)
  const scopeReferred = scopeProfiles?.find((p) => p.id === commission.referred_user_id)
  // D3-E: a known test/unknown-linked commission id must not load as
  // an ordinary Real Data detail -- checked before history/adjustments/
  // payment/profile-name/listing-title fetches below. All three actors
  // (affiliate, merchant, referred user) plus the listing's is_test
  // are direct columns on this row -- no transaction tracing needed.
  if (
    classifyEntityWithOwners({ is_test: scopeListing?.is_test === true }, [scopeAffiliate ?? {}, scopeMerchant ?? {}, scopeReferred ?? {}]) !== 'real'
  ) {
    return null
  }

  const [{ data: history }, { data: adjustments }, { data: payment }, { data: profiles }, { data: listing }] = await Promise.all([
    admin.from('affiliate_commission_history').select('*').eq('commission_id', commissionId).order('created_at', { ascending: false }),
    admin.from('affiliate_commission_adjustments').select('*').eq('commission_id', commissionId).order('created_at', { ascending: false }),
    admin.from('payments').select('id, status, amount, currency, provider, captured_at').eq('id', commission.payment_id).maybeSingle(),
    admin.from('profiles').select('id, full_name, display_name').in('id', [commission.affiliate_id, commission.merchant_id]),
    admin.from('listings').select('title').eq('id', commission.listing_id).maybeSingle(),
  ])

  const affiliateProfile = profiles?.find((p) => p.id === commission.affiliate_id)
  const merchantProfile = profiles?.find((p) => p.id === commission.merchant_id)

  return {
    commission,
    history: history ?? [],
    adjustments: adjustments ?? [],
    payment: payment ?? null,
    affiliateName: affiliateProfile?.full_name ?? affiliateProfile?.display_name ?? null,
    merchantName: merchantProfile?.full_name ?? merchantProfile?.display_name ?? null,
    listingTitle: listing?.title ?? null,
  }
}

const COMMISSION_CSV_COLUMNS: (keyof AdminCommissionRow)[] = [
  'id',
  'transactionType',
  'affiliateName',
  'merchantName',
  'listingTitle',
  'reference',
  'commissionAmount',
  'currency',
  'status',
  'createdAt',
  'approvedAt',
  'paidAt',
]

export const AFFILIATE_COMMISSION_CSV_COLUMNS = COMMISSION_CSV_COLUMNS

export interface RealAffiliateOverviewCounts {
  activeAffiliates: number
  affiliateCommissionsPending: number
  affiliateCommissionsHeld: number
  affiliateCommissionsPayoutQueued: number
  affiliateCommissionsFailed: number
}

/**
 * D3-E: the 5 affiliate-derived Admin Overview metrics, scoped to
 * confirmed real actors only. active_affiliates requires the
 * affiliate's own profile real (the same rule listAdminAffiliates
 * already applies). The 4 commission status counts require affiliate
 * real AND merchant real AND referred_user real AND the linked
 * listing.is_test=false -- the exact same rule
 * listAdminAffiliateCommissions already applies. Preserves every
 * existing status definition from get_admin_overview_stats() verbatim.
 */
export async function getRealAffiliateOverviewCounts(admin: SupabaseClient): Promise<RealAffiliateOverviewCounts> {
  const scopedCommissions = () =>
    admin
      .from('affiliate_commissions')
      .select(
        `id,
        listings!inner(is_test),
        affiliate_profile:profiles!affiliate_commissions_affiliate_id_fkey!inner(data_classification),
        merchant_profile:profiles!affiliate_commissions_merchant_id_fkey!inner(data_classification),
        referred_profile:profiles!affiliate_commissions_referred_user_id_fkey!inner(data_classification)`,
        { count: 'exact', head: true }
      )
      .eq('listings.is_test', false)
      .eq('affiliate_profile.data_classification', 'real')
      .eq('merchant_profile.data_classification', 'real')
      .eq('referred_profile.data_classification', 'real')

  const [
    { count: activeAffiliates },
    { count: affiliateCommissionsPending },
    { count: affiliateCommissionsHeld },
    { count: affiliateCommissionsPayoutQueued },
    { count: affiliateCommissionsFailed },
  ] = await Promise.all([
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('is_affiliate', true).eq('data_classification', 'real'),
    scopedCommissions().eq('status', 'pending'),
    scopedCommissions().eq('status', 'held'),
    scopedCommissions().eq('status', 'payout_queued'),
    scopedCommissions().eq('status', 'failed'),
  ])

  return {
    activeAffiliates: activeAffiliates ?? 0,
    affiliateCommissionsPending: affiliateCommissionsPending ?? 0,
    affiliateCommissionsHeld: affiliateCommissionsHeld ?? 0,
    affiliateCommissionsPayoutQueued: affiliateCommissionsPayoutQueued ?? 0,
    affiliateCommissionsFailed: affiliateCommissionsFailed ?? 0,
  }
}
