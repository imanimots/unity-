import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isAdvertisingEnabled } from '@/lib/advertising/config'

/**
 * Shared handler for the advertiser-facing single-arg campaign actions
 * (pause/resume/cancel) -- each is `rpcName(actor_id, campaign_id,
 * [reason], [idempotency_key])`, differing only in the RPC name and
 * whether a free-text reason is accepted. Keeps the route files
 * themselves to one line of actual logic.
 */
export function handleSimpleCampaignAction(rpcName: string, rateLimitKey: string, acceptsReason: boolean) {
  return async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    if (!isAdvertisingEnabled()) {
      return NextResponse.json({ error: 'Advertising is not currently available' }, { status: 503 })
    }
    const { id: campaignId } = await params
    if (!isValidUuid(campaignId)) {
      return NextResponse.json({ error: 'Invalid campaign id' }, { status: 400 })
    }
    const rate = checkRateLimit(`${rateLimitKey}:${getClientKey(request)}`, 20, 60_000)
    if (!rate.allowed) {
      return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
    }
    const requester = await getRequestProfile()
    if (!requester) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    let body: { reason?: string; idempotencyKey?: string } = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const admin = await getAdminServiceClient()
    if (!admin) {
      return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
    }

    const rpcArgs: Record<string, unknown> = {
      p_actor_profile_id: requester.userId,
      p_campaign_id: campaignId,
      p_idempotency_key: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
    }
    if (acceptsReason) {
      rpcArgs.p_reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null
    }

    const { data, error } = await admin.rpc(rpcName, rpcArgs)
    if (error) {
      console.error(`[advertising.campaigns.${rpcName}] RPC error`, { userId: requester.userId, campaignId, error })
      return NextResponse.json({ error: error.message ?? 'Action failed' }, { status: 400 })
    }
    return NextResponse.json(data)
  }
}
