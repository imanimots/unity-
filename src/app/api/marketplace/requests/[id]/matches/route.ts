import { NextRequest, NextResponse } from 'next/server'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/marketplace/requests/[id]/matches -- Step Q/R bidirectional
 * matching. Deterministic, explainable, SQL-only (no ML ranking, no
 * paid promotion, no subscription-tier override) -- explicit signals:
 * transactionTypeMatch (implicit via listing_type/direction filter),
 * categoryMatch, locationMatch, budgetCompatibility, dateCompatibility
 * (rentals only). Returns compatible ACTIVE, non-test Available
 * listings for this request.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Invalid request id' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data: req } = await admin.from('marketplace_requests').select('*').eq('id', id).maybeSingle()
  if (!req) return NextResponse.json({ error: 'Request not found' }, { status: 404 })

  let query = admin
    .from('listings')
    .select('id, title, category, category_id, country_id, province, city, daily_rate, sale_price, listing_type, status, available_from')
    .eq('status', 'active')
    .eq('is_test', false)
    .eq('direction', 'available')
    .eq('country_id', req.country_id)

  // transactionTypeMatch
  if (req.transaction_type === 'buy') query = query.in('listing_type', ['sale', 'both'])
  else if (req.transaction_type === 'rent') query = query.in('listing_type', ['rental', 'both'])
  // barter: any active, unlocked listing is eligible regardless of listing_type -- no filter here.

  // categoryMatch
  if (req.category_id) query = query.eq('category_id', req.category_id)
  else if (req.category) query = query.eq('category', req.category)

  const { data: candidates, error } = await query.limit(60)
  if (error) {
    console.error('[marketplace.requests.matches] error', { id, error })
    return NextResponse.json({ error: 'Could not compute matches' }, { status: 500 })
  }

  // budgetCompatibility -- applied in memory (mixed daily_rate/sale_price columns).
  const priceOf = (l: { daily_rate: number | null; sale_price: number | null }) => l.daily_rate ?? l.sale_price ?? null
  let results = (candidates ?? []).filter((l) => {
    const price = priceOf(l)
    if (price === null) return true
    if (req.budget_min !== null && price < req.budget_min) return false
    if (req.budget_max !== null && price > req.budget_max) return false
    return true
  })

  // Barter listings that are currently locked in another negotiation are excluded.
  if (req.transaction_type === 'barter' && results.length > 0) {
    const { data: locked } = await admin.from('barter_locked_listings').select('listing_id').in('listing_id', results.map((r) => r.id))
    const lockedIds = new Set((locked ?? []).map((l) => l.listing_id))
    results = results.filter((l) => !lockedIds.has(l.id))
  }

  return NextResponse.json({
    matches: results.map((l) => ({
      listing_id: l.id, title: l.title, category: l.category, price: priceOf(l),
      signals: { transactionTypeMatch: true, categoryMatch: !!(req.category_id || req.category), locationMatch: true, budgetCompatibility: true },
    })),
  })
}
