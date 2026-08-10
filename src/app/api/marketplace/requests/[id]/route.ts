import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { updateMarketplaceRequestFieldsSchema } from '@/lib/marketplace/validation'
import { mapMarketplaceRpcError } from '@/lib/marketplace/rpc-errors'
import { getMarketplaceRequestDetail } from '@/lib/data/marketplace-requests'

interface RouteParams {
  params: Promise<{ id: string }>
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value)
}

/**
 * GET /api/marketplace/requests/[id] -- public detail for a published,
 * non-test request (RLS also enforces this at the table level; the
 * owner may additionally fetch their own draft via the session client
 * elsewhere). Never exposes private email/phone/address/KYC/payout
 * data -- only the public-safe requester fields already used elsewhere
 * (full_name/display_name, no more).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!isValidUuid(id)) return NextResponse.json({ error: 'Invalid request id' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const requester = await getRequestProfile()

  const detail = await getMarketplaceRequestDetail(admin, id, requester?.userId ?? null)
  if (!detail) return NextResponse.json({ error: 'Request not found' }, { status: 404 })

  return NextResponse.json(detail)
}

/** PATCH /api/marketplace/requests/[id] -- owner, draft-only edit. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!isValidUuid(id)) return NextResponse.json({ error: 'Invalid request id' }, { status: 400 })

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
  const parsed = updateMarketplaceRequestFieldsSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data, error } = await admin.rpc('update_marketplace_request', {
    p_actor_user_id: requester.userId,
    p_request_id: id,
    p_title: parsed.data.title ?? null,
    p_description: parsed.data.description ?? null,
    p_category: parsed.data.category ?? null,
    p_category_id: parsed.data.category_id ?? null,
    p_subcategory_id: parsed.data.subcategory_id ?? null,
    p_province: parsed.data.province ?? null,
    p_city: parsed.data.city ?? null,
    p_budget_min: parsed.data.budget_min ?? null,
    p_budget_max: parsed.data.budget_max ?? null,
    p_start_date: parsed.data.start_date ?? null,
    p_end_date: parsed.data.end_date ?? null,
    p_quantity: parsed.data.quantity ?? null,
    p_condition_preferences: parsed.data.condition_preferences ?? null,
    p_barter_offer_description: parsed.data.barter_offer_description ?? null,
    p_specifications: parsed.data.specifications ?? null,
    p_expires_at: parsed.data.expires_at ?? null,
  })

  if (error) {
    const mapped = mapMarketplaceRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data)
}
