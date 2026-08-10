import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { mapMarketplaceRpcError } from '@/lib/marketplace/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** POST /api/admin/marketplace-requests/[id]/close -- narrow moderation action (Step AF), reason required, reuses the same RPC the owner path uses with actor_role='admin'. No arbitrary financial editing. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!isValidUuid(id)) return NextResponse.json({ error: 'Invalid request id' }, { status: 400 })

  const gate = await requireAdminForRoute(request, 'admin:marketplace-requests:close')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Marketplace storage is not configured' }, { status: 503 })

  let body: unknown
  try { body = await request.json() } catch { body = {} }
  const reason = (body as { reason?: string })?.reason
  if (!reason || !reason.trim()) return NextResponse.json({ error: 'A reason is required' }, { status: 400 })

  const { data, error } = await admin.rpc('close_marketplace_request', {
    p_actor_user_id: gate.requester.userId, p_actor_role: 'admin', p_request_id: id, p_reason: reason,
  })
  if (error) {
    const mapped = mapMarketplaceRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data)
}
