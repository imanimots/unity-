import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { submitReviewSchema } from '@/lib/reviews/validation'
import { mapReviewsRpcError } from '@/lib/reviews/rpc-errors'
import { sendTemplate } from '@/lib/email'
import { resolveTransactionTitle, resolveRecipientName } from '@/lib/reviews/notify'

/**
 * POST /api/reviews/submit — the single review-submission entry point
 * for all 4 transaction domains (buy/rent/barter/rent_to_buy). Reviews
 * V2: eligibility, the double-blind window, immutability, and the
 * publish-both-on-second-submission reveal are all enforced inside
 * submit_review() (supabase/migrations/20260904000009_reviews_v2_rpcs.sql)
 * -- this route never computes eligibility itself, only forwards the
 * authenticated actor id and validated body.
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Review storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`reviews:submit:${getClientKey(request)}`, 10, 60_000)
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

  const parsed = submitReviewSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid review', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('submit_review', {
      p_actor_user_id: requester.userId,
      p_domain: parsed.data.domain,
      p_transaction_id: parsed.data.transaction_id,
      p_rating: parsed.data.rating,
      p_comment: parsed.data.comment ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[reviews.submit] RPC error', { userId: requester.userId, body: parsed.data, error })
      const mapped = mapReviewsRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    // Early reveal (Rule 17): the second submission just published both
    // reviews atomically inside the RPC -- notify both parties now.
    if (data?.both_now_published) {
      const title = await resolveTransactionTitle(admin, parsed.data.domain, parsed.data.transaction_id)
      for (const recipientUserId of [requester.userId, data.reviewee_id as string]) {
        try {
          const name = await resolveRecipientName(admin, recipientUserId)
          await sendTemplate(admin, {
            eventType: 'review.published',
            templateId: 'review-published',
            recipientUserId,
            relatedEntityType: 'review',
            relatedEntityId: parsed.data.transaction_id,
            occurrenceKey: `review-published-early-${parsed.data.domain}-${parsed.data.transaction_id}-${recipientUserId}`,
            vars: { recipientName: name, transactionTitle: title },
          })
        } catch (notifyErr) {
          console.error('[reviews.submit] early-reveal notify failed', { recipientUserId, notifyErr })
        }
      }
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[reviews.submit] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not submit your review — please try again' }, { status: 500 })
  }
}
