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

  // mockScenario is dev/test-only input -- a caller must never be able to
  // certify a payment outcome in any environment where the mock provider
  // could conceivably run. The provider registry already refuses "mock"
  // entirely when NODE_ENV=production (defense layer 1); this is an
  // explicit second layer specifically for the funding route itself, so
  // a client-supplied scenario is rejected outright rather than silently
  // ignored -- fail loud, not fail quiet.
  if (process.env.NODE_ENV === 'production' && parsed.data.mockScenario) {
    return NextResponse.json({ error: 'mockScenario is not permitted in this environment' }, { status: 400 })
  }

  let settlementId: string | null = null
  let quoteId: string | null = null
  if (parsed.data.fundingSource === 'provider') {
    const { data: campaign, error: campaignErr } = await admin.from('ad_campaigns').select('advertiser_id, is_test').eq('id', campaignId).maybeSingle()
    if (campaignErr || !campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Authoritative, PERSISTED funding quote -- once created, its base
    // price/discount/amount-due/currency are frozen. This is the fix for
    // the proven price/plan race: the provider is charged this exact
    // frozen amount, the settlement is bound to this exact quote, and
    // fund_ad_campaign() below consumes the quote's frozen values
    // directly rather than re-deriving pricing from current package/plan
    // state -- a later package or plan change can never strand an
    // already-charged attempt. Retry-safe by construction: this RPC
    // reuses an existing open quote for the same campaign instead of
    // minting a new one, so calling it again (e.g. on a client retry)
    // never risks a second external charge on its own.
    const { data: quote, error: quoteErr } = await admin.rpc('create_ad_campaign_funding_quote', {
      p_actor_profile_id: requester.userId,
      p_campaign_id: campaignId,
    })
    if (quoteErr || !quote) {
      return NextResponse.json({ error: quoteErr?.message ?? 'Could not price this campaign' }, { status: 400 })
    }
    quoteId = quote.quote_id

    // Retry safety, second half: if a verified settlement was already
    // recorded for this exact quote (a prior request in this same
    // attempt already charged the provider successfully, but the
    // response never completed -- e.g. a network timeout before
    // fund_ad_campaign ran), reuse it instead of charging the provider
    // again. This is what makes an HTTP crash after a successful charge
    // safely retryable without a second external charge.
    const { data: existingSettlement } = await admin
      .from('ad_provider_settlements')
      .select('id')
      .eq('quote_id', quoteId)
      .eq('status', 'verified')
      .maybeSingle()

    if (existingSettlement) {
      settlementId = existingSettlement.id
    } else {
      const providerKey = process.env.ADVERTISING_BILLING_PROVIDER || 'mock'
      const provider = getAdvertisingBillingProvider()
      const charge = await provider.charge({
        advertiserId: campaign.advertiser_id,
        campaignId,
        amountCents: quote.amount_due_cents,
        currency: quote.currency,
        mockScenario: parsed.data.mockScenario as AdvertisingMockScenario | undefined,
      })
      if (charge.status !== 'succeeded') {
        // Declined/timeout: no verified settlement is ever recorded, and
        // fund_ad_campaign is never called -- there is nothing for a
        // failed charge to leave behind. The quote itself remains open
        // (unconsumed) and will simply expire if never retried.
        return NextResponse.json({ error: `Billing charge failed: ${charge.failureReason ?? 'unknown'}` }, { status: 402 })
      }

      // Trusted server code records the verified settlement AFTER (and
      // only after) the provider itself reported success -- this is the
      // one and only path that can ever create a row in
      // ad_provider_settlements. The client never supplies amount,
      // currency, discount, or the settlement fields directly; they are
      // derived server-side from the same frozen quote, and the
      // settlement is permanently bound to it.
      const { data: settlement, error: settlementErr } = await admin.rpc('record_ad_provider_settlement', {
        p_advertiser_id: campaign.advertiser_id,
        p_provider: providerKey,
        p_provider_reference: charge.providerReference,
        p_amount_cents: quote.amount_due_cents,
        p_currency: quote.currency,
        p_is_test: campaign.is_test,
        p_quote_id: quoteId,
      })
      if (settlementErr || !settlement) {
        console.error('[advertising.campaigns.fund] settlement recording failed', { userId: requester.userId, campaignId, settlementErr })
        return NextResponse.json({ error: settlementErr?.message ?? 'Could not record payment settlement' }, { status: 400 })
      }
      settlementId = settlement.id
    }
  }

  const { data, error } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: requester.userId,
    p_campaign_id: campaignId,
    p_funding_source: parsed.data.fundingSource,
    p_settlement_id: settlementId,
    p_idempotency_key: parsed.data.idempotencyKey ?? null,
    p_quote_id: quoteId,
  })

  if (error) {
    console.error('[advertising.campaigns.fund] RPC error', { userId: requester.userId, campaignId, error })
    return NextResponse.json({ error: error.message ?? 'Could not fund campaign' }, { status: 400 })
  }

  return NextResponse.json(data)
}
