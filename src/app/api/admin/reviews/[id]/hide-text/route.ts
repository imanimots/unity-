import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { mapReviewsRpcError } from '@/lib/reviews/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}
const bodySchema = z.object({ reason: z.string().trim().min(1).max(1000), idempotency_key: z.string().min(1).max(200).optional() })

/** POST /api/admin/reviews/[id]/hide-text — text moderation only; the underlying rating remains valid and keeps contributing to aggregates. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const gate = await requireAdminForRoute(request, 'admin:reviews:moderate')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'A reason is required.' }, { status: 400 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Review storage is not configured' }, { status: 503 })

  const { data, error } = await admin.rpc('admin_hide_review_text', {
    p_admin_id: gate.requester.userId,
    p_review_id: id,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })
  if (error) {
    console.error('[admin.reviews.hide-text] RPC error', { id, error })
    const mapped = mapReviewsRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data)
}
