import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/barter/[id] -- full agreement detail for a party. Uses the
 * session client throughout -- RLS ("barter_agreements: parties read"
 * and the equivalent party-scoped policies on the child tables) is the
 * actual enforcement boundary, not an ownership check in this route.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: agreementId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(agreementId)) {
    return NextResponse.json({ error: 'Invalid barter agreement id' }, { status: 400 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const { data: agreement, error: agreementError } = await supabase
    .from('barter_agreements')
    .select('*')
    .eq('id', agreementId)
    .maybeSingle()

  if (agreementError) {
    console.error('[barter.detail] error', { userId: requester.userId, agreementId, error: agreementError })
    return NextResponse.json({ error: 'Could not load this trade' }, { status: 500 })
  }
  if (!agreement) {
    // RLS makes a non-party's row indistinguishable from a nonexistent one.
    return NextResponse.json({ error: 'Barter agreement not found' }, { status: 404 })
  }

  const [{ data: offers }, { data: history }, { data: confirmations }, { data: payments }] = await Promise.all([
    supabase.from('barter_offers').select('*').eq('agreement_id', agreementId).order('version', { ascending: true }),
    supabase.from('barter_history').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: true }),
    supabase.from('barter_confirmations').select('*').eq('agreement_id', agreementId),
    // Step 11 Phase 4 -- deposit/cash-adjustment payment rows. RLS
    // ("payments: parties read") already covers barter rows generically
    // (renter_id/merchant_id repurposed as payer/counterparty), no new
    // policy needed.
    supabase.from('payments').select('*').eq('barter_agreement_id', agreementId),
  ])

  const offerIds = (offers ?? []).map((o) => o.id)
  const { data: items } = offerIds.length
    ? await supabase.from('barter_offer_items').select('*, listing:listings(*)').in('offer_id', offerIds)
    : { data: [] as { offer_id: string }[] }

  const itemsByOffer = new Map<string, unknown[]>()
  for (const item of items ?? []) {
    const list = itemsByOffer.get(item.offer_id) ?? []
    list.push(item)
    itemsByOffer.set(item.offer_id, list)
  }

  const offersWithItems = (offers ?? []).map((o) => ({ ...o, items: itemsByOffer.get(o.id) ?? [] }))

  return NextResponse.json({
    agreement,
    offers: offersWithItems,
    history: history ?? [],
    confirmations: confirmations ?? [],
    payments: payments ?? [],
  })
}
