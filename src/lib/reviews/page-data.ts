import { createClient } from '@/lib/supabase/server'
import { getPublicProfile } from '@/lib/data/profiles'
import type { ReviewDomain } from './validation'

export interface ReviewPageData {
  transactionTitle: string
  revieweeId: string
  revieweeName: string
  alreadySubmitted: boolean
  existingReview: { rating: number; comment: string | null; publishedAt: string | null } | null
}

/**
 * Server-side data for a review-submission page. Uses the session-scoped
 * (RLS-respecting) client for the transaction row itself — a row only
 * comes back if the signed-in user is genuinely a participant, which is
 * the existing, already-established RLS posture for
 * bookings/orders/barter_agreements/rent_to_buy_agreements. This is a
 * read-side convenience only: the actual eligibility gate (terminal
 * status, dispute fallback, cutover, 14-day window) is enforced
 * server-side inside submit_review() regardless of what this returns —
 * a stale/optimistic "eligible-looking" render here can never bypass it.
 */
export async function loadReviewPageData(domain: ReviewDomain, transactionId: string, currentUserId: string): Promise<ReviewPageData | null> {
  const supabase = await createClient()
  if (!supabase) return null

  let revieweeId: string | null = null
  let transactionTitle = 'Item'

  if (domain === 'buy') {
    const { data } = await supabase.from('orders').select('buyer_id, seller_id, listings(title)').eq('id', transactionId).maybeSingle()
    if (!data) return null
    revieweeId = currentUserId === data.buyer_id ? data.seller_id : data.buyer_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionTitle = (data as any).listings?.title ?? transactionTitle
  } else if (domain === 'rent') {
    const { data } = await supabase.from('bookings').select('renter_id, merchant_id, listings(title)').eq('id', transactionId).maybeSingle()
    if (!data) return null
    revieweeId = currentUserId === data.renter_id ? data.merchant_id : data.renter_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionTitle = (data as any).listings?.title ?? transactionTitle
  } else if (domain === 'barter') {
    const { data } = await supabase
      .from('barter_agreements')
      .select('party_a_id, party_b_id, anchor_listing_id, anchor_skill_task_post_id, source_skill_task_post_id, listings:anchor_listing_id(title)')
      .eq('id', transactionId)
      .maybeSingle()
    if (!data) return null
    revieweeId = currentUserId === data.party_a_id ? data.party_b_id : data.party_a_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyData = data as any
    if (anyData.listings?.title) {
      transactionTitle = anyData.listings.title
    } else {
      const postId = data.anchor_skill_task_post_id ?? data.source_skill_task_post_id
      if (postId) {
        const { data: post } = await supabase.from('barter_skill_task_posts').select('title').eq('id', postId).maybeSingle()
        if (post?.title) transactionTitle = post.title
      }
    }
  } else if (domain === 'rent_to_buy') {
    const { data } = await supabase.from('rent_to_buy_agreements').select('customer_id, merchant_id, listings(title)').eq('id', transactionId).maybeSingle()
    if (!data) return null
    revieweeId = currentUserId === data.customer_id ? data.merchant_id : data.customer_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transactionTitle = (data as any).listings?.title ?? transactionTitle
  }

  if (!revieweeId) return null

  const revieweeProfile = await getPublicProfile(revieweeId)
  const revieweeName = revieweeProfile.status === 'ok' ? revieweeProfile.profile.displayName : 'Former Unity user'

  const column = { buy: 'order_id', rent: 'booking_id', barter: 'barter_agreement_id', rent_to_buy: 'rent_to_buy_agreement_id' }[domain]
  const { data: existing } = await supabase.from('reviews').select('rating, comment, published_at').eq(column, transactionId).eq('reviewer_id', currentUserId).maybeSingle()

  return {
    transactionTitle,
    revieweeId,
    revieweeName,
    alreadySubmitted: !!existing,
    existingReview: existing ? { rating: existing.rating, comment: existing.comment, publishedAt: existing.published_at } : null,
  }
}
