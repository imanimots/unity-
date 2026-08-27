import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { mapReviewsRpcError } from '@/lib/reviews/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}
const bodySchema = z.object({
  status: z.enum(['reviewed', 'dismissed']),
  resolution_note: z.string().trim().max(1000).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
})

/** POST /api/admin/review-reports/[id]/close — dismiss a report, or mark it reviewed (typically after acting via a separate hide/invalidate call). Reporting never auto-hides content by itself. */
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
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Review storage is not configured' }, { status: 503 })

  const { data, error } = await admin.rpc('admin_close_review_report', {
    p_admin_id: gate.requester.userId,
    p_report_id: id,
    p_status: parsed.data.status,
    p_resolution_note: parsed.data.resolution_note ?? null,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })
  if (error) {
    console.error('[admin.review-reports.close] RPC error', { id, error })
    const mapped = mapReviewsRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }
  return NextResponse.json(data)
}
