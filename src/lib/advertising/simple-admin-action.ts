import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'

/**
 * Shared handler for admin single-target advertising actions
 * (approve/reject/suspend/restore across advertisers/campaigns/
 * creatives) -- each RPC is `rpcName(admin_id, target_id, [reason],
 * [idempotency_key])`.
 */
export function handleSimpleAdminAction(rpcName: string, rateLimitKey: string, reasonRequired: boolean) {
  return async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id: targetId } = await params
    if (!isValidUuid(targetId)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }

    const gate = await requireAdminForRoute(request, rateLimitKey)
    if (!gate.ok) return gate.response

    let body: { reason?: string; idempotencyKey?: string } = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }
    if (reasonRequired && (!body.reason || body.reason.trim().length === 0)) {
      return NextResponse.json({ error: 'A reason is required' }, { status: 400 })
    }

    const admin = await getAdminServiceClient()
    if (!admin) {
      return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
    }

    // The target-id parameter name differs per RPC family
    // (p_advertiser_id vs p_campaign_id) -- supabase-js RPC calls bind
    // by exact named keys, so the correct key must be selected here.
    const argKey = rpcName.includes('advertiser') ? 'p_advertiser_id' : 'p_campaign_id'
    const rpcArgs: Record<string, unknown> = {
      p_admin_id: gate.requester.userId,
      [argKey]: targetId,
      p_reason: typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null,
      p_idempotency_key: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null,
    }

    const { data: result, error: rpcError } = await admin.rpc(rpcName, rpcArgs)
    if (rpcError) {
      console.error(`[admin.advertising.${rpcName}] RPC error`, { adminId: gate.requester.userId, targetId, error: rpcError })
      return NextResponse.json({ error: rpcError.message ?? 'Action failed' }, { status: 400 })
    }
    return NextResponse.json(result)
  }
}
