import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'

const bodySchema = z.object({
  entityType: z.enum(['listing', 'marketplace_request', 'barter_skill_task_post']),
  entityId: z.string().uuid(),
  scheduledAt: z.string().datetime(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
})

/** GET /api/subscriptions/scheduled-publications -- the caller's own scheduled publications (Pro/Elite only). */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })

  const entitlements = await getMerchantEntitlements(admin, requester.userId)
  if (!entitlements.scheduledPublishingEnabled) {
    return NextResponse.json({ error: 'Scheduled publishing requires an active Pro or Elite subscription' }, { status: 403 })
  }

  const { data, error } = await admin.from('merchant_scheduled_publications').select('*').eq('merchant_id', requester.userId).order('scheduled_at', { ascending: true })
  if (error) return NextResponse.json({ error: 'Could not load scheduled publications' }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

/** POST /api/subscriptions/scheduled-publications -- Pro/Elite only (Section 3-4). */
export async function POST(request: NextRequest) {
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })

  const entitlements = await getMerchantEntitlements(admin, requester.userId)
  if (!entitlements.scheduledPublishingEnabled) {
    return NextResponse.json({ error: 'Scheduled publishing requires an active Pro or Elite subscription' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const { data, error } = await admin.rpc('schedule_entity_publication', {
    p_merchant_id: requester.userId,
    p_entity_type: parsed.data.entityType,
    p_entity_id: parsed.data.entityId,
    p_scheduled_at: parsed.data.scheduledAt,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[subscriptions.scheduled-publications] RPC error', { userId: requester.userId, error })
    const message = error.message ?? ''
    if (message.includes('scheduled_at must be in the future')) return NextResponse.json({ error: 'Scheduled time must be in the future.' }, { status: 400 })
    if (message.includes('not currently in a schedulable status')) return NextResponse.json({ error: 'This item is not currently eligible to be scheduled.' }, { status: 409 })
    return NextResponse.json({ error: 'Could not schedule this publication — please try again' }, { status: 500 })
  }

  return NextResponse.json(data)
}
