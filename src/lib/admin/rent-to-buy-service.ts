import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100

export async function listAdminRentToBuyAgreements(admin: SupabaseClient, filters: { status?: string; search?: string } = {}) {
  let query = admin.from('rent_to_buy_agreements').select('*').order('created_at', { ascending: false }).limit(DEFAULT_LIMIT)
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

  let rows = agreements.map((a) => ({
    ...a,
    merchant: merchantById.get(a.merchant_id) ?? null,
    customer: customerById.get(a.customer_id) ?? null,
    listing: listingById.get(a.listing_id) ?? null,
  }))

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
