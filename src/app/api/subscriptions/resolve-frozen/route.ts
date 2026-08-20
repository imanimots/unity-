import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { mapSubscriptionRpcError } from '@/lib/subscriptions/rpc-errors'

const bodySchema = z.object({
  entities: z.array(z.object({ entityType: z.enum(['listing', 'marketplace_request', 'barter_skill_task_post']), entityId: z.string().uuid() })).max(500),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
})

/**
 * POST /api/subscriptions/resolve-frozen -- the ONLY way a merchant's
 * publication_frozen state clears (Section 21-22). This is the
 * merchant's OWN explicit choice, made right now -- Unity never
 * auto-selects on their behalf, even though this runs after the
 * downgrade's effective date.
 */
export async function POST(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const { data, error } = await admin.rpc('resolve_frozen_merchant_downgrade', {
    p_merchant_id: requester.userId,
    p_entities: parsed.data.entities,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[subscriptions.resolve-frozen] RPC error', { userId: requester.userId, error })
    const mapped = mapSubscriptionRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
