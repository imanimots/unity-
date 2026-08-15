import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isAdvertisingEnabled } from '@/lib/advertising/config'

const bodySchema = z.object({
  advertiserId: z.string().uuid(),
  packageId: z.string().uuid(),
  targetType: z.enum(['listing', 'marketplace_request', 'barter_skill_task_post', 'external']),
  listingId: z.string().uuid().optional(),
  marketplaceRequestId: z.string().uuid().optional(),
  barterSkillTaskPostId: z.string().uuid().optional(),
  endAt: z.string().datetime(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
})

/** POST /api/advertising/campaigns -- create a draft campaign. */
export async function POST(request: NextRequest) {
  if (!isAdvertisingEnabled()) {
    return NextResponse.json({ error: 'Advertising is not currently available' }, { status: 503 })
  }

  const rate = checkRateLimit(`advertising:campaigns:create:${getClientKey(request)}`, 20, 60_000)
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

  const { data, error } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: requester.userId,
    p_advertiser_id: parsed.data.advertiserId,
    p_package_id: parsed.data.packageId,
    p_target_type: parsed.data.targetType,
    p_listing_id: parsed.data.listingId ?? null,
    p_marketplace_request_id: parsed.data.marketplaceRequestId ?? null,
    p_barter_skill_task_post_id: parsed.data.barterSkillTaskPostId ?? null,
    p_end_at: parsed.data.endAt,
    p_is_test: false,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
  })

  if (error) {
    console.error('[advertising.campaigns.create] RPC error', { userId: requester.userId, error })
    return NextResponse.json({ error: error.message ?? 'Could not create campaign' }, { status: 400 })
  }

  return NextResponse.json(data, { status: 201 })
}

/** GET /api/advertising/campaigns -- the caller's own campaigns (across all owned advertiser accounts). */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const { data: advertisers } = await admin.from('ad_advertisers').select('id').eq('owner_profile_id', requester.userId)
  const advertiserIds = (advertisers ?? []).map((a) => a.id)
  if (advertiserIds.length === 0) {
    return NextResponse.json({ campaigns: [] })
  }

  const { data, error } = await admin.from('ad_campaigns').select('*').in('advertiser_id', advertiserIds).order('created_at', { ascending: false })
  if (error) {
    return NextResponse.json({ error: 'Could not load campaigns' }, { status: 500 })
  }

  return NextResponse.json({ campaigns: data ?? [] })
}
