import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isAdvertisingEnabled } from '@/lib/advertising/config'

const bodySchema = z.object({
  headline: z.string().trim().min(1).max(120),
  ctaText: z.string().trim().min(1).max(40),
  destinationUrl: z.string().url().startsWith('https://'),
  imageUrl: z.string().url().optional(),
  shortDescription: z.string().max(300).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
})

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/advertising/campaigns/[id]/creative -- external creative submit/edit. Material changes invalidate any prior approval (enforced in the RPC). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  if (!isAdvertisingEnabled()) {
    return NextResponse.json({ error: 'Advertising is not currently available' }, { status: 503 })
  }
  const { id: campaignId } = await params
  if (!isValidUuid(campaignId)) {
    return NextResponse.json({ error: 'Invalid campaign id' }, { status: 400 })
  }
  const rate = checkRateLimit(`advertising:campaigns:creative:${getClientKey(request)}`, 20, 60_000)
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
  if (/^https:\/\/(javascript|data|file):/i.test(parsed.data.destinationUrl)) {
    return NextResponse.json({ error: 'Unsafe destination URL' }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('update_ad_creative', {
    p_actor_profile_id: requester.userId,
    p_campaign_id: campaignId,
    p_headline: parsed.data.headline,
    p_cta_text: parsed.data.ctaText,
    p_destination_url: parsed.data.destinationUrl,
    p_image_url: parsed.data.imageUrl ?? null,
    p_short_description: parsed.data.shortDescription ?? null,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
  })

  if (error) {
    console.error('[advertising.campaigns.creative] RPC error', { userId: requester.userId, campaignId, error })
    return NextResponse.json({ error: error.message ?? 'Could not update creative' }, { status: 400 })
  }

  return NextResponse.json(data)
}
