import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { createMarketplaceRequestSchema } from '@/lib/marketplace/validation'
import { mapMarketplaceRpcError } from '@/lib/marketplace/rpc-errors'
import { computeCreateRequestHash, checkIdempotentReplay } from '@/lib/marketplace/idempotency'

/**
 * POST /api/marketplace/requests -- create a draft Looking For request.
 * No KYC gate at draft creation (mirrors draft listing creation) --
 * publishing is the gated action.
 *
 * GET /api/marketplace/requests -- public browse of published
 * (non-draft, non-test) requests. Unverified/anonymous users may
 * browse freely (Step I).
 */
export async function POST(request: NextRequest) {
  const rate = checkRateLimit(`marketplace:requests:create:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = createMarketplaceRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  if (parsed.data.idempotency_key) {
    const hash = computeCreateRequestHash(parsed.data.title, parsed.data.transaction_type, parsed.data.description)
    const replay = await checkIdempotentReplay(admin, requester.userId, 'create_marketplace_request', parsed.data.idempotency_key, hash)
    if (replay.status === 'replay') return NextResponse.json(replay.result)
    if (replay.status === 'conflict') {
      const mapped = mapMarketplaceRpcError('idempotency key already used with a different request')
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
  }

  const { data, error } = await admin.rpc('create_marketplace_request', {
    p_requester_id: requester.userId,
    p_transaction_type: parsed.data.transaction_type,
    p_title: parsed.data.title,
    p_description: parsed.data.description ?? null,
    p_category: parsed.data.category ?? null,
    p_category_id: parsed.data.category_id ?? null,
    p_subcategory_id: parsed.data.subcategory_id ?? null,
    p_country_id: parsed.data.country_id ?? 'ZA',
    p_province: parsed.data.province ?? null,
    p_city: parsed.data.city ?? null,
    p_budget_min: parsed.data.budget_min ?? null,
    p_budget_max: parsed.data.budget_max ?? null,
    p_currency: parsed.data.currency ?? 'ZAR',
    p_start_date: parsed.data.start_date ?? null,
    p_end_date: parsed.data.end_date ?? null,
    p_quantity: parsed.data.quantity ?? 1,
    p_condition_preferences: parsed.data.condition_preferences ?? null,
    p_barter_offer_description: parsed.data.barter_offer_description ?? null,
    p_specifications: parsed.data.specifications ?? {},
    p_expires_at: parsed.data.expires_at ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[marketplace.requests.create] RPC error', { userId: requester.userId, error })
    const mapped = mapMarketplaceRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data, { status: 201 })
}

export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  const { searchParams } = new URL(request.url)
  const transactionType = searchParams.get('transaction_type')
  const category = searchParams.get('category')
  const countryId = searchParams.get('country_id') ?? 'ZA'
  const q = searchParams.get('q')
  const status = searchParams.get('status')
  const sort = searchParams.get('sort') ?? 'newest'
  const limit = Math.min(Number(searchParams.get('limit')) || 24, 100)

  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(url, anonKey)

  let query = supabase
    .from('marketplace_requests')
    .select('id, requester_id, transaction_type, status, title, description, category, country_id, province, city, budget_min, budget_max, currency, start_date, end_date, expires_at, created_at')
    .eq('is_test', false)
    .neq('status', 'draft')

  if (status) {
    query = query.eq('status', status)
  } else {
    query = query.in('status', ['active', 'offers_received'])
  }
  if (transactionType) query = query.eq('transaction_type', transactionType)
  if (category) query = query.eq('category', category)
  if (countryId) query = query.eq('country_id', countryId)
  if (q) query = query.ilike('title', `%${q}%`)

  if (sort === 'budget_asc') query = query.order('budget_min', { ascending: true, nullsFirst: false })
  else if (sort === 'budget_desc') query = query.order('budget_max', { ascending: false, nullsFirst: false })
  else query = query.order('created_at', { ascending: false })

  const { data, error } = await query.limit(limit)
  if (error) {
    console.error('[marketplace.requests.list] error', error)
    return NextResponse.json({ error: 'Could not load requests' }, { status: 500 })
  }

  return NextResponse.json({ requests: data ?? [] })
}
