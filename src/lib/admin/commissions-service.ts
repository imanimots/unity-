import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100

export interface AdminUnityCommissionRow {
  id: string
  transactionType: string
  status: string
  merchantId: string
  merchantName: string | null
  listingId: string
  listingTitle: string | null
  reference: string | null
  merchantPlanId: string
  eligibleBase: number
  standardRateBps: number
  excessRateBps: number
  excessBase: number
  commissionAmount: number
  currency: string
  createdAt: string
  earnedAt: string | null
  hasRefundOrDispute: boolean
}

export interface AdminUnityCommissionFilters {
  merchantId?: string
  listingId?: string
  transactionType?: string
  status?: string
  search?: string
  limit?: number
}

/** Mirrors listAdminAffiliateCommissions' exact shape: one base query + Promise.all of related-table lookups + in-memory joins. */
export async function listAdminUnityCommissions(admin: SupabaseClient, filters: AdminUnityCommissionFilters): Promise<AdminUnityCommissionRow[]> {
  let query = admin
    .from('unity_commissions')
    .select(
      'id, transaction_type, status, merchant_id, listing_id, order_id, booking_id, payment_id, merchant_plan_id, eligible_base, standard_rate_bps, excess_rate_bps, excess_base, commission_amount, currency, created_at, earned_at, listings(title)'
    )
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.merchantId) query = query.eq('merchant_id', filters.merchantId)
  if (filters.listingId) query = query.eq('listing_id', filters.listingId)
  if (filters.transactionType && filters.transactionType !== 'all') query = query.eq('transaction_type', filters.transactionType)
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const merchantIds = Array.from(new Set(rows.map((r) => r.merchant_id)))
  const paymentIds = rows.map((r) => r.payment_id)

  const [{ data: profiles }, { data: payments }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name').in('id', merchantIds),
    admin.from('payments').select('id, status').in('id', paymentIds),
  ])

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const paymentStatusById = new Map((payments ?? []).map((p) => [p.id, p.status]))

  let results: AdminUnityCommissionRow[] = rows.map((r) => ({
    id: r.id,
    transactionType: r.transaction_type,
    status: r.status,
    merchantId: r.merchant_id,
    merchantName: nameById.get(r.merchant_id) ?? null,
    listingId: r.listing_id,
    listingTitle: (r.listings as unknown as { title: string } | null)?.title ?? null,
    reference: r.order_id ?? r.booking_id,
    merchantPlanId: r.merchant_plan_id,
    eligibleBase: r.eligible_base,
    standardRateBps: r.standard_rate_bps,
    excessRateBps: r.excess_rate_bps,
    excessBase: r.excess_base,
    commissionAmount: r.commission_amount,
    currency: r.currency,
    createdAt: r.created_at,
    earnedAt: r.earned_at,
    hasRefundOrDispute: ['refunded', 'partially_refunded', 'chargeback'].includes(paymentStatusById.get(r.payment_id) ?? ''),
  }))

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    results = results.filter(
      (c) => (c.merchantName ?? '').toLowerCase().includes(q) || (c.listingTitle ?? '').toLowerCase().includes(q) || (c.reference ?? '').toLowerCase().includes(q)
    )
  }

  return results
}

export interface AdminUnityCommissionDetail {
  commission: Record<string, unknown>
  history: Record<string, unknown>[]
  adjustments: Record<string, unknown>[]
  payment: Record<string, unknown> | null
  merchantName: string | null
  listingTitle: string | null
}

export async function getAdminUnityCommissionDetail(admin: SupabaseClient, commissionId: string): Promise<AdminUnityCommissionDetail | null> {
  const { data: commission, error } = await admin.from('unity_commissions').select('*').eq('id', commissionId).maybeSingle()
  if (error) throw error
  if (!commission) return null

  const [{ data: history }, { data: adjustments }, { data: payment }, { data: merchantProfile }, { data: listing }] = await Promise.all([
    admin.from('unity_commission_history').select('*').eq('commission_id', commissionId).order('created_at', { ascending: false }),
    admin.from('unity_commission_adjustments').select('*').eq('commission_id', commissionId).order('created_at', { ascending: false }),
    admin.from('payments').select('id, status, amount, currency, provider, captured_at').eq('id', commission.payment_id).maybeSingle(),
    admin.from('profiles').select('id, full_name, display_name').eq('id', commission.merchant_id).maybeSingle(),
    admin.from('listings').select('title').eq('id', commission.listing_id).maybeSingle(),
  ])

  return {
    commission,
    history: history ?? [],
    adjustments: adjustments ?? [],
    payment: payment ?? null,
    merchantName: merchantProfile?.full_name ?? merchantProfile?.display_name ?? null,
    listingTitle: listing?.title ?? null,
  }
}

const COMMISSION_CSV_COLUMNS: (keyof AdminUnityCommissionRow)[] = [
  'id',
  'transactionType',
  'merchantName',
  'listingTitle',
  'reference',
  'merchantPlanId',
  'eligibleBase',
  'commissionAmount',
  'currency',
  'status',
  'createdAt',
  'earnedAt',
]

export const UNITY_COMMISSION_CSV_COLUMNS = COMMISSION_CSV_COLUMNS
