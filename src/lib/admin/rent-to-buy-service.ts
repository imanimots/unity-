import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyEntityWithOwners } from '@/lib/admin/data-scope'

const DEFAULT_LIMIT = 100

/**
 * D3-D: real requires rent_to_buy_agreements.is_test = false AND BOTH
 * merchant_id and customer_id positively real (FKs
 * `rent_to_buy_agreements_merchant_id_fkey`/`_customer_id_fkey`,
 * confirmed from supabase/migrations/20260827000003_rtb_schema.sql).
 * Scoped via inner-joined, aliased profiles, before `.limit()` -- `*`
 * is kept so every existing agreement column this file already spreads
 * downstream remains present.
 */
export async function listAdminRentToBuyAgreements(admin: SupabaseClient, filters: { status?: string; search?: string } = {}) {
  let query = admin
    .from('rent_to_buy_agreements')
    .select(
      `*,
      merchant_profile:profiles!rent_to_buy_agreements_merchant_id_fkey!inner(data_classification),
      customer_profile:profiles!rent_to_buy_agreements_customer_id_fkey!inner(data_classification)`
    )
    .eq('is_test', false)
    .eq('merchant_profile.data_classification', 'real')
    .eq('customer_profile.data_classification', 'real')
    .order('created_at', { ascending: false })
    .limit(DEFAULT_LIMIT)
  if (filters.status) query = query.eq('status', filters.status)
  const { data: agreements, error } = await query
  if (error || !agreements) return []

  const merchantIds = [...new Set(agreements.map((a) => a.merchant_id))]
  const customerIds = [...new Set(agreements.map((a) => a.customer_id))]
  const listingIds = [...new Set(agreements.map((a) => a.listing_id))]

  const [{ data: merchants }, { data: customers }, { data: listings }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name, kyc_status').in('id', merchantIds),
    admin.from('profiles').select('id, full_name, display_name, kyc_status').in('id', customerIds),
    admin.from('listings').select('id, title').in('id', listingIds),
  ])

  const merchantById = new Map((merchants ?? []).map((m) => [m.id, m]))
  const customerById = new Map((customers ?? []).map((c) => [c.id, c]))
  const listingById = new Map((listings ?? []).map((l) => [l.id, l]))

  let rows = agreements.map((a) => {
    // merchant_profile/customer_profile exist only to express the D3-D
    // real-data join filter above -- never part of the response shape.
    const agreement = { ...a } as typeof a & { merchant_profile?: unknown; customer_profile?: unknown }
    delete agreement.merchant_profile
    delete agreement.customer_profile
    return {
      ...agreement,
      merchant: merchantById.get(a.merchant_id) ?? null,
      customer: customerById.get(a.customer_id) ?? null,
      listing: listingById.get(a.listing_id) ?? null,
    }
  })

  if (filters.search) {
    const q = filters.search.toLowerCase()
    rows = rows.filter((r) =>
      r.listing?.title?.toLowerCase().includes(q) ||
      r.merchant?.full_name?.toLowerCase().includes(q) ||
      r.customer?.full_name?.toLowerCase().includes(q) ||
      r.id.includes(q)
    )
  }

  return rows
}

export async function getAdminRentToBuyAgreementDetail(admin: SupabaseClient, agreementId: string) {
  const { data: agreement } = await admin.from('rent_to_buy_agreements').select('*').eq('id', agreementId).maybeSingle()
  if (!agreement) return null

  const { data: scopeProfiles } = await admin
    .from('profiles')
    .select('id, data_classification')
    .in('id', [agreement.merchant_id, agreement.customer_id])
  const merchantScope = scopeProfiles?.find((p) => p.id === agreement.merchant_id)
  const customerScope = scopeProfiles?.find((p) => p.id === agreement.customer_id)
  // D3-D: a known test/unknown-linked agreement id must not load as an
  // ordinary Real Data RTB detail -- checked before every other fetch.
  if (classifyEntityWithOwners({ is_test: agreement.is_test === true }, [merchantScope ?? {}, customerScope ?? {}]) !== 'real') {
    return null
  }

  const [{ data: installments }, { data: history }, { data: returnCases }, { data: listing }, { data: merchant }, { data: customer }, { data: disputes }, { data: commissions }, { data: payouts }, { data: evidence }, { data: amendments }] = await Promise.all([
    admin.from('rent_to_buy_installments').select('*').eq('agreement_id', agreementId).order('sequence', { ascending: true }),
    admin.from('rent_to_buy_history').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: true }),
    admin.from('rent_to_buy_return_cases').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: false }),
    admin.from('listings').select('id, title').eq('id', agreement.listing_id).maybeSingle(),
    admin.from('profiles').select('id, full_name, display_name, kyc_status').eq('id', agreement.merchant_id).maybeSingle(),
    admin.from('profiles').select('id, full_name, display_name, kyc_status').eq('id', agreement.customer_id).maybeSingle(),
    admin.from('disputes').select('id, status').eq('rent_to_buy_agreement_id', agreementId),
    admin.from('unity_commissions').select('*').eq('rent_to_buy_agreement_id', agreementId),
    admin.from('merchant_payouts').select('*').eq('rent_to_buy_agreement_id', agreementId),
    admin.from('rent_to_buy_evidence').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: true }),
    admin.from('rent_to_buy_amendments').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: false }),
  ])

  const paidPrincipal = (installments ?? []).filter((i) => i.status === 'paid').reduce((sum, i) => sum + Number(i.principal_amount), 0)

  return {
    agreement,
    listing,
    merchant,
    customer,
    installments: installments ?? [],
    history: history ?? [],
    returnCases: returnCases ?? [],
    disputes: disputes ?? [],
    commissions: commissions ?? [],
    payouts: payouts ?? [],
    evidence: evidence ?? [],
    amendments: amendments ?? [],
    purchaseProgress: {
      paidPrincipal,
      totalPurchasePrice: Number(agreement.total_purchase_price),
      remainingBalance: Math.max(0, Number(agreement.total_purchase_price) - paidPrincipal),
      percentPaid: Number(agreement.total_purchase_price) > 0 ? Math.min(100, (paidPrincipal / Number(agreement.total_purchase_price)) * 100) : 0,
    },
    // Admin visibility across all dimensions, never a single collapsed
    // status -- and deliberately no admin RPC exists to casually edit
    // any of these (immutable agreement economics stay RPC-gated only).
    statusDimensions: {
      paymentStatus: agreement.fully_paid_at ? 'fully_paid' : (installments ?? []).some((i) => i.status === 'paid') ? 'partially_paid' : 'awaiting_first_payment',
      possessionStatus: agreement.possession_status,
      ownershipStatus: agreement.ownership_status,
      escrowSettled: Boolean(agreement.settled_at),
      defaultStatus: agreement.default_at ? 'formally_defaulted' : 'not_defaulted',
      returnStatus: returnCases && returnCases.length > 0 ? returnCases[0].status : 'not_applicable',
      depositStatus: agreement.deposit_forfeited_at ? 'forfeited' : agreement.deposit_refunded_at ? 'refunded' : agreement.deposit_funded_at ? 'held' : 'not_funded',
    },
  }
}

export interface RealRentToBuyOverviewCounts {
  rtbAgreementsAwaitingFirstPayment: number
  rtbAgreementsActive: number
  rtbAgreementsDefaulted: number
  rtbAgreementsReturnRequired: number
  rtbAgreementsCompleted: number
}

/**
 * D3-D-F1: the 5 rent-to-buy-derived Admin Overview metrics, scoped to
 * confirmed real agreements only -- is_test=false AND merchant real
 * AND customer real, the exact same rule listAdminRentToBuyAgreements
 * already applies. Preserves every existing status/possession_status
 * grouping from get_admin_overview_stats() verbatim (note:
 * rtb_commission_events_policy_pending is Finance-adjacent and
 * deliberately NOT included here -- out of scope for this phase).
 */
export async function getRealRentToBuyOverviewCounts(admin: SupabaseClient): Promise<RealRentToBuyOverviewCounts> {
  const scoped = () =>
    admin
      .from('rent_to_buy_agreements')
      .select(
        'id, merchant_profile:profiles!rent_to_buy_agreements_merchant_id_fkey!inner(data_classification), customer_profile:profiles!rent_to_buy_agreements_customer_id_fkey!inner(data_classification)',
        { count: 'exact', head: true }
      )
      .eq('is_test', false)
      .eq('merchant_profile.data_classification', 'real')
      .eq('customer_profile.data_classification', 'real')

  const [
    { count: rtbAgreementsAwaitingFirstPayment },
    { count: rtbAgreementsActive },
    { count: rtbAgreementsDefaulted },
    { count: rtbAgreementsReturnRequired },
    { count: rtbAgreementsCompleted },
  ] = await Promise.all([
    scoped().eq('status', 'awaiting_first_payment'),
    scoped().eq('status', 'active'),
    scoped().eq('status', 'defaulted'),
    scoped().eq('possession_status', 'return_required'),
    scoped().eq('status', 'completed'),
  ])

  return {
    rtbAgreementsAwaitingFirstPayment: rtbAgreementsAwaitingFirstPayment ?? 0,
    rtbAgreementsActive: rtbAgreementsActive ?? 0,
    rtbAgreementsDefaulted: rtbAgreementsDefaulted ?? 0,
    rtbAgreementsReturnRequired: rtbAgreementsReturnRequired ?? 0,
    rtbAgreementsCompleted: rtbAgreementsCompleted ?? 0,
  }
}
