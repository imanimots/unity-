import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  inventoryClass: z.enum(['unity_marketplace', 'external']),
  placementType: z.enum(['homepage_banner', 'search_loading_popup', 'search_result', 'promoted_deals']),
  placementTier: z.enum(['value', 'standard', 'premium']),
  positionBand: z.string().trim().min(1).max(100),
  priceCents: z.number().int().min(0),
  impressionQuota: z.number().int().min(1),
  currency: z.string().length(3).default('ZAR'),
  isActive: z.boolean().default(false),
  isTest: z.boolean().default(false),
})

/** GET /api/admin/advertising/packages -- the full catalogue, including inactive/test rows (admin only). */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:advertising:packages:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }
  const { data, error } = await admin.from('ad_packages').select('*').order('created_at', { ascending: false })
  if (error) {
    return NextResponse.json({ error: 'Could not load packages' }, { status: 500 })
  }
  return NextResponse.json({ packages: data ?? [] })
}

/** POST /api/admin/advertising/packages -- create a new package. No production Rand amounts are ever fabricated server-side; the admin supplies every commercial value explicitly. */
export async function POST(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:advertising:packages:create')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('admin_create_ad_package', {
    p_admin_id: gate.requester.userId,
    p_name: parsed.data.name,
    p_inventory_class: parsed.data.inventoryClass,
    p_placement_type: parsed.data.placementType,
    p_placement_tier: parsed.data.placementTier,
    p_position_band: parsed.data.positionBand,
    p_price_cents: parsed.data.priceCents,
    p_impression_quota: parsed.data.impressionQuota,
    p_currency: parsed.data.currency,
    p_is_active: parsed.data.isActive,
    p_is_test: parsed.data.isTest,
  })

  if (error) {
    console.error('[admin.advertising.packages.create] RPC error', { adminId: gate.requester.userId, error })
    return NextResponse.json({ error: error.message ?? 'Could not create package' }, { status: 400 })
  }

  return NextResponse.json(data, { status: 201 })
}
