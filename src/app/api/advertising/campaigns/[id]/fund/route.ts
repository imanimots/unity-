import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isAdvertisingEnabled } from '@/lib/advertising/config'
import { getAdvertisingBillingProvider } from '@/lib/advertising/registry'
import type { AdvertisingMockScenario } from '@/lib/advertising/provider'

const bodySchema = z.object({
  fundingSource: z.enum(['balance', 'provider']),
  mockScenario: z.enum(['success', 'declined', 'timeout']).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
})

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/advertising/campaigns/[id]/fund -- charges the balance or the mock billing provider, then activates/submits the campaign. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  if (!isAdvertisingEnabled()) {
    return NextResponse.json({ error: 'Advertising is not currently available' }, { status: 503 })
  }

  const { id: campaignId } = await params
  if (!isValidUuid(campaignId)) {
    return NextResponse.json({ error: 'Invalid campaign id' }, { status: 400 })
  }

  const rate = checkRateLimit(`advertising:campaigns:fund:${getClientKey(request)}`, 10, 60_000)
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

  let providerReference: string | null = null
  if (parsed.data.fundingSource === 'provider') {
    const { data: campaign, error: campaignErr } = await admin.from('ad_campaigns').select('advertiser_id, snapshot_price_cents, snapshot_currency').eq('id', campaignId).maybeSingle()
    if (campaignErr || !campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }
    const provider = getAdvertisingBillingProvider()
    const charge = await provider.charge({
      advertiserId: campaign.advertiser_id,
      campaignId,
      amountCents: campaign.snapshot_price_cents,
      currency: campaign.snapshot_currency,
      mockScenario: parsed.data.mockScenario as AdvertisingMockScenario | undefined,
    })
    if (charge.status !== 'succeeded') {
      return NextResponse.json({ error: `Billing charge failed: ${charge.failureReason ?? 'unknown'}` }, { status: 402 })
    }
    providerReference = charge.providerReference
  }

  const { data, error } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: requester.userId,
    p_campaign_id: campaignId,
    p_funding_source: parsed.data.fundingSource,
    p_provider_reference: providerReference,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
  })

  if (error) {
    console.error('[advertising.campaigns.fund] RPC error', { userId: requester.userId, campaignId, error })
    return NextResponse.json({ error: error.message ?? 'Could not fund campaign' }, { status: 400 })
  }

  return NextResponse.json(data)
}
