import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Shared detail resolver -- one implementation used by both the
 * customer/merchant detail route and the admin detail service, matching
 * the exact convention getMarketplaceRequestDetail() established in
 * Phase 4 (avoids a self-fetch that would need to manually forward
 * session cookies).
 */
export async function getRentToBuyAgreementDetail(admin: SupabaseClient, agreementId: string, viewerUserId: string | null) {
  const { data: agreement } = await admin.from('rent_to_buy_agreements').select('*').eq('id', agreementId).maybeSingle()
  if (!agreement) return null

  const isMerchant = viewerUserId === agreement.merchant_id
  const isCustomer = viewerUserId === agreement.customer_id
  if (!isMerchant && !isCustomer) return null

  const [{ data: installments }, { data: history }, { data: returnCases }, { data: listing }, { data: evidence }, { data: amendments }] = await Promise.all([
    admin.from('rent_to_buy_installments').select('*').eq('agreement_id', agreementId).order('sequence', { ascending: true }),
    admin.from('rent_to_buy_history').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: true }),
    admin.from('rent_to_buy_return_cases').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: false }),
    admin.from('listings').select('id, title').eq('id', agreement.listing_id).maybeSingle(),
    admin.from('rent_to_buy_evidence').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: true }),
    admin.from('rent_to_buy_amendments').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: false }),
  ])

  const paidPrincipal = (installments ?? []).filter((i) => i.status === 'paid').reduce((sum, i) => sum + Number(i.principal_amount), 0)
  const pendingAmendment = (amendments ?? []).find((a) => a.status === 'proposed') ?? null

  return {
    agreement,
    listing,
    isMerchant,
    isCustomer,
    installments: installments ?? [],
    history: history ?? [],
    returnCases: returnCases ?? [],
    evidence: evidence ?? [],
    amendments: amendments ?? [],
    pendingAmendment,
    purchaseProgress: {
      paidPrincipal,
      totalPurchasePrice: Number(agreement.total_purchase_price),
      remainingBalance: Math.max(0, Number(agreement.total_purchase_price) - paidPrincipal),
      percentPaid: Number(agreement.total_purchase_price) > 0 ? Math.min(100, (paidPrincipal / Number(agreement.total_purchase_price)) * 100) : 0,
    },
    // Four independently-tracked status dimensions, kept separate for the
    // UI (Rule: never collapse payment/possession/ownership/escrow/
    // return/default status into one generic label).
    statusDimensions: {
      paymentStatus: agreement.fully_paid_at ? 'fully_paid' : (installments ?? []).some((i) => i.status === 'paid') ? 'partially_paid' : 'awaiting_first_payment',
      possessionStatus: agreement.possession_status,
      ownershipStatus: agreement.ownership_status,
      defaultStatus: agreement.default_at ? 'formally_defaulted' : 'not_defaulted',
      returnStatus: returnCases && returnCases.length > 0 ? returnCases[0].status : 'not_applicable',
    },
  }
}
