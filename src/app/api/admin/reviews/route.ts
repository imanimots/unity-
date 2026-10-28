import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { classifyEntityWithOwners } from '@/lib/admin/data-scope'

/**
 * GET /api/admin/reviews — open review/reply reports, with safe
 * transaction provenance context, for the moderation queue. Never
 * exposes private payment/deposit/dispute/KYC details — only what's
 * already safe for public display plus the report's own metadata.
 *
 * D3-D: a report targets either a review directly or a reply (which
 * itself always resolves back to exactly one review), so a report's
 * real-data provenance is the TARGET REVIEW's: reviews.is_test = false
 * AND both reviewer_id and reviewee_id positively real. Like disputes,
 * this is a report-against-review resolution PostgREST cannot express
 * as a single embedded-relationship filter on `review_reports` itself,
 * so the row-count bound (.limit(200)) moves to AFTER classification
 * -- never before it.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:reviews:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Review storage is not configured' }, { status: 503 })
  }

  try {
    const { data: reports, error } = await admin
      .from('review_reports')
      .select('id, reporter_id, target_type, target_id, reason, description, status, created_at, resolved_at, resolved_by, resolution_note')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[admin.reviews.list] reports query error', error)
      return NextResponse.json({ error: 'Could not load reports' }, { status: 500 })
    }

    const reviewIds = new Set<string>()
    const replyIds = new Set<string>()
    for (const r of reports ?? []) {
      if (r.target_type === 'review') reviewIds.add(r.target_id)
      if (r.target_type === 'reply') replyIds.add(r.target_id)
    }

    let repliesById = new Map<string, { id: string; review_id: string; reply_text: string; hidden_at: string | null }>()
    if (replyIds.size > 0) {
      const { data: replies } = await admin.from('review_replies').select('id, review_id, reply_text, hidden_at').in('id', [...replyIds])
      for (const r of replies ?? []) reviewIds.add(r.review_id)
      repliesById = new Map((replies ?? []).map((r) => [r.id, r]))
    }

    let reviewsById = new Map<
      string,
      { id: string; rating: number; comment: string | null; header_snapshot: unknown; reviewer_id: string; reviewee_id: string; text_hidden_at: string | null; invalidated_at: string | null; published_at: string | null; is_test: boolean }
    >()
    if (reviewIds.size > 0) {
      const { data: reviews } = await admin
        .from('reviews')
        .select('id, rating, comment, header_snapshot, reviewer_id, reviewee_id, text_hidden_at, invalidated_at, published_at, is_test')
        .in('id', [...reviewIds])
      reviewsById = new Map((reviews ?? []).map((r) => [r.id, r]))
    }

    const reviewerRevieweeIds = Array.from(
      new Set(Array.from(reviewsById.values()).flatMap((r) => [r.reviewer_id, r.reviewee_id]))
    )
    const { data: reviewProfiles } = reviewerRevieweeIds.length
      ? await admin.from('profiles').select('id, data_classification').in('id', reviewerRevieweeIds)
      : { data: [] }
    const reviewProfileById = new Map((reviewProfiles ?? []).map((p) => [p.id, { data_classification: p.data_classification }]))

    /** D3-D: the review a report ultimately targets, resolving a reply report to its parent review -- the same resolution the enrichment below already performs, factored out so classification and display agree. */
    function targetReviewFor(report: { target_type: string; target_id: string }) {
      return report.target_type === 'review' ? reviewsById.get(report.target_id) : reviewsById.get(repliesById.get(report.target_id)?.review_id ?? '')
    }

    const realReports = (reports ?? []).filter((r) => {
      const review = targetReviewFor(r)
      if (!review) return false
      const reviewer = reviewProfileById.get(review.reviewer_id) ?? {}
      const reviewee = reviewProfileById.get(review.reviewee_id) ?? {}
      return classifyEntityWithOwners({ is_test: review.is_test === true }, [reviewer, reviewee]) === 'real'
    })

    const { data: history } = await admin
      .from('review_moderation_history')
      .select('id, review_id, action, actor_admin_id, reason, created_at')
      .in('review_id', [...reviewIds])
      .order('created_at', { ascending: false })

    const enriched = realReports.slice(0, 200).map((r) => ({
      ...r,
      review: targetReviewFor(r) ?? null,
      reply: r.target_type === 'reply' ? repliesById.get(r.target_id) ?? null : null,
    }))

    return NextResponse.json({ reports: enriched, history: history ?? [] })
  } catch (err) {
    console.error('[admin.reviews.list] unexpected error', err)
    return NextResponse.json({ error: 'Could not load reports' }, { status: 500 })
  }
}
