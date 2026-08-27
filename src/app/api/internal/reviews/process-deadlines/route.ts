import { NextRequest, NextResponse } from 'next/server'
import { sendTemplate } from '@/lib/email'
import { resolveTransactionTitle, resolveRecipientName } from '@/lib/reviews/notify'

const PROCESS_LIMIT = 200

/**
 * POST /api/internal/reviews/process-deadlines -- the narrow, bounded,
 * idempotent processor for Reviews V2's notification lifecycle:
 * discovering newly-eligible transactions (+ eligibility email), day-10
 * reminders, and 14-day deadline resolution (one-sided publish + email,
 * or silent expiry). All DB state transitions happen inside
 * process_review_deadlines() (supabase/migrations/20260904000009_reviews_v2_rpcs.sql);
 * this route only dispatches the notifications the RPC reports back,
 * exactly mirroring the reconcile-missing route's
 * "RPC returns candidates, route processes them" split.
 *
 * Secret-authenticated, matching every other route in
 * src/app/api/internal/** -- no scheduler is configured for this route
 * by this phase (see the final report's Notifications section); wiring
 * one later requires no new code, only external cron configuration
 * pointed at this URL with the INTERNAL_CRON_SECRET header, exactly like
 * every other unscheduled internal route in this codebase.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.INTERNAL_CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Internal reviews processor is not configured' }, { status: 503 })
  }
  const provided = request.headers.get('authorization')
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Review storage is not configured' }, { status: 503 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('process_review_deadlines', { p_limit: PROCESS_LIMIT })
    if (error) {
      console.error('[internal.reviews.process-deadlines] RPC error', { error })
      return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
    }

    const newWindows: Array<{ domain: string; transaction_id: string; party_a_id: string; party_b_id: string }> = data?.new_windows ?? []
    const reminders: Array<{ domain: string; transaction_id: string; recipient_id: string }> = data?.reminders ?? []
    const resolutions: Array<{ domain: string; transaction_id: string; party_a_id: string; party_b_id: string; resolution: string }> = data?.resolutions ?? []

    let sent = 0
    let failed = 0

    for (const w of newWindows) {
      for (const recipientUserId of [w.party_a_id, w.party_b_id]) {
        try {
          const title = await resolveTransactionTitle(admin, w.domain, w.transaction_id)
          const name = await resolveRecipientName(admin, recipientUserId)
          await sendTemplate(admin, {
            eventType: 'review.eligible',
            templateId: 'review-eligible',
            recipientUserId,
            relatedEntityType: 'review',
            relatedEntityId: w.transaction_id,
            occurrenceKey: `review-eligible-${w.domain}-${w.transaction_id}-${recipientUserId}`,
            vars: { recipientName: name, transactionTitle: title },
          })
          sent++
        } catch (err) {
          console.error('[internal.reviews.process-deadlines] eligibility notify failed', { w, err })
          failed++
        }
      }
    }

    for (const r of reminders) {
      try {
        const title = await resolveTransactionTitle(admin, r.domain, r.transaction_id)
        const name = await resolveRecipientName(admin, r.recipient_id)
        await sendTemplate(admin, {
          eventType: 'review.reminder',
          templateId: 'review-reminder',
          recipientUserId: r.recipient_id,
          relatedEntityType: 'review',
          relatedEntityId: r.transaction_id,
          occurrenceKey: `review-reminder-${r.domain}-${r.transaction_id}-${r.recipient_id}`,
          vars: { recipientName: name, transactionTitle: title },
        })
        sent++
      } catch (err) {
        console.error('[internal.reviews.process-deadlines] reminder notify failed', { r, err })
        failed++
      }
    }

    for (const res of resolutions) {
      if (res.resolution !== 'one_published') continue
      for (const recipientUserId of [res.party_a_id, res.party_b_id]) {
        try {
          const title = await resolveTransactionTitle(admin, res.domain, res.transaction_id)
          const name = await resolveRecipientName(admin, recipientUserId)
          await sendTemplate(admin, {
            eventType: 'review.published',
            templateId: 'review-published',
            recipientUserId,
            relatedEntityType: 'review',
            relatedEntityId: res.transaction_id,
            occurrenceKey: `review-published-expiry-${res.domain}-${res.transaction_id}-${recipientUserId}`,
            vars: { recipientName: name, transactionTitle: title },
          })
          sent++
        } catch (err) {
          console.error('[internal.reviews.process-deadlines] expiry-publish notify failed', { res, err })
          failed++
        }
      }
    }

    return NextResponse.json({
      new_windows: newWindows.length,
      reminders: reminders.length,
      resolutions: resolutions.length,
      notifications_sent: sent,
      notifications_failed: failed,
    })
  } catch (err) {
    console.error('[internal.reviews.process-deadlines] unexpected error', { err })
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}
