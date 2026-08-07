/**
 * Unity SEO Pre-Launch Hardening — Part B (remove fabricated ratings).
 *
 * There is no genuine item-level review in this schema today: `reviews`
 * is keyed by `reviewee_id` (a merchant/profile), not a listing, and the
 * live dev project has zero rows in it. `profiles.unity_score` is real
 * (DB-trigger-derived from actual reviews — see update_unity_score()),
 * but it is a merchant trust score, not a per-item rating, and every
 * profile currently sits at its schema default (5.00) with zero reviews
 * behind it.
 *
 * The previous listing-card rendering fabricated a review count with
 * `Math.floor(score * 8 + listing.id.length)` — a number with no
 * relationship to any real review. This module replaces that: it never
 * derives a count from anything, it only ever passes through a genuine
 * count a caller already has. No caller in this codebase has one today,
 * so every call currently resolves to "don't show a rating" — exactly
 * the safe default this phase requires. Once real per-listing reviews
 * exist, a caller can pass the real aggregate here with zero changes to
 * this file.
 */

export interface ListingRatingInput {
  averageRating: number | null | undefined
  reviewCount: number | null | undefined
}

export interface ListingRatingDisplay {
  show: boolean
  score: number
  reviewCount: number
}

const HIDDEN: ListingRatingDisplay = { show: false, score: 0, reviewCount: 0 }

/** Shows a rating only when given a genuine positive review count and a real average — never derives either value. */
export function deriveListingRatingDisplay(input: ListingRatingInput): ListingRatingDisplay {
  if (!input.reviewCount || input.reviewCount <= 0) return HIDDEN
  if (input.averageRating == null || Number.isNaN(input.averageRating)) return HIDDEN
  return { show: true, score: input.averageRating, reviewCount: input.reviewCount }
}
