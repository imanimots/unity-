import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { submitReviewReplySchema } from '@/lib/reviews/validation'
import { mapReviewsRpcError } from '@/lib/reviews/rpc-errors'
import { sendTemplate } from '@/lib/email'
import { resolveRecipientName } from '@/lib/reviews/notify'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/reviews/[id]/reply — the reviewed party's one public reply,
 * only reachable once the review is published and within 30 days of
 * publication (submit_review_reply() enforces both server-side).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: reviewId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) {
    return NextResponse.json({ error: 'Invalid review id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Review storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`reviews:reply:${getClientKey(request)}`, 10, 60_000)
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

  const parsed = submitReviewReplySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid reply', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('submit_review_reply', {
      p_actor_user_id: requester.userId,
      p_review_id: reviewId,
      p_reply_text: parsed.data.reply_text,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[reviews.reply] RPC error', { userId: requester.userId, reviewId, error })
      const mapped = mapReviewsRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    const reviewerIdToNotify = data?.reviewer_id_to_notify as string | undefined
    if (reviewerIdToNotify) {
      try {
        const { data: review } = await admin.from('reviews').select('header_snapshot').eq('id', reviewId).maybeSingle()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const title = (review?.header_snapshot as any)?.title ?? 'your transaction'
        const name = await resolveRecipientName(admin, reviewerIdToNotify)
        await sendTemplate(admin, {
          eventType: 'review.reply_received',
          templateId: 'review-reply-received',
          recipientUserId: reviewerIdToNotify,
          relatedEntityType: 'review',
          relatedEntityId: reviewId,
          occurrenceKey: `review-reply-${reviewId}`,
          vars: { recipientName: name, transactionTitle: title },
        })
      } catch (notifyErr) {
        console.error('[reviews.reply] notify failed', { reviewId, notifyErr })
      }
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[reviews.reply] unexpected error', { userId: requester.userId, reviewId, err })
    return NextResponse.json({ error: 'Could not submit your reply — please try again' }, { status: 500 })
  }
}
