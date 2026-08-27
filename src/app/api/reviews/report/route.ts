import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { reportReviewContentSchema } from '@/lib/reviews/validation'
import { mapReviewsRpcError } from '@/lib/reviews/rpc-errors'

/**
 * POST /api/reviews/report — only the reviewed person may report the
 * review about them; only the original reviewer may report the public
 * reply beneath their review. Ownership is verified server-side inside
 * report_review_content(), never trusted from the client. Reporting
 * never auto-hides content, never alters rating/aggregates.
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Review storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`reviews:report:${getClientKey(request)}`, 10, 60_000)
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
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = reportReviewContentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid report', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('report_review_content', {
      p_actor_user_id: requester.userId,
      p_target_type: parsed.data.target_type,
      p_target_id: parsed.data.target_id,
      p_reason: parsed.data.reason,
      p_description: parsed.data.description ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[reviews.report] RPC error', { userId: requester.userId, body: parsed.data, error })
      const mapped = mapReviewsRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[reviews.report] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not submit your report — please try again' }, { status: 500 })
  }
}
