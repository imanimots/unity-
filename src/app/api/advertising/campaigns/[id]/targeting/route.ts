import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isAdvertisingEnabled } from '@/lib/advertising/config'

const bodySchema = z.object({
  mode: z.string().max(50).optional(),
  direction: z.string().max(50).optional(),
  kind: z.string().max(50).optional(),
  category: z.string().max(100).optional(),
  keywords: z.array(z.string().max(50)).max(20).optional(),
  countryId: z.string().max(10).optional(),
  province: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
})

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/advertising/campaigns/[id]/targeting -- update (versioned) contextual targeting. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  if (!isAdvertisingEnabled()) {
    return NextResponse.json({ error: 'Advertising is not currently available' }, { status: 503 })
  }
  const { id: campaignId } = await params
  if (!isValidUuid(campaignId)) {
    return NextResponse.json({ error: 'Invalid campaign id' }, { status: 400 })
  }
  const rate = checkRateLimit(`advertising:campaigns:targeting:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

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

  const { data, error } = await admin.rpc('update_ad_targeting', {
    p_actor_profile_id: requester.userId,
    p_campaign_id: campaignId,
    p_mode: parsed.data.mode ?? null,
    p_direction: parsed.data.direction ?? null,
    p_kind: parsed.data.kind ?? null,
    p_category: parsed.data.category ?? null,
    p_keywords: parsed.data.keywords ?? [],
    p_country_id: parsed.data.countryId ?? null,
    p_province: parsed.data.province ?? null,
    p_city: parsed.data.city ?? null,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
  })

  if (error) {
    console.error('[advertising.campaigns.targeting] RPC error', { userId: requester.userId, campaignId, error })
    return NextResponse.json({ error: error.message ?? 'Could not update targeting' }, { status: 400 })
  }

  return NextResponse.json(data)
}
