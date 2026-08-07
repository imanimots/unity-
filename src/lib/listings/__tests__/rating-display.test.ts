import { describe, it, expect } from 'vitest'
import { deriveListingRatingDisplay } from '../rating-display'

describe('deriveListingRatingDisplay — no fabricated ratings (category: Fabricated Ratings)', () => {
  it('1. hides the rating when review count is zero (the current real state of every listing)', () => {
    expect(deriveListingRatingDisplay({ averageRating: 5, reviewCount: 0 })).toEqual({ show: false, score: 0, reviewCount: 0 })
  })

  it('2. hides the rating when review count is missing entirely', () => {
    expect(deriveListingRatingDisplay({ averageRating: 5, reviewCount: undefined })).toEqual({ show: false, score: 0, reviewCount: 0 })
  })

  it('3. hides the rating when review count is negative (defensive — should never happen, but never renders on bad input)', () => {
    expect(deriveListingRatingDisplay({ averageRating: 5, reviewCount: -1 })).toEqual({ show: false, score: 0, reviewCount: 0 })
  })

  it('4. hides the rating when average rating is null even if a count is present', () => {
    expect(deriveListingRatingDisplay({ averageRating: null, reviewCount: 12 })).toEqual({ show: false, score: 0, reviewCount: 0 })
  })

  it('5. shows the rating only when a genuine positive count and average are both present, passed through exactly (never recomputed)', () => {
    expect(deriveListingRatingDisplay({ averageRating: 4.5, reviewCount: 12 })).toEqual({ show: true, score: 4.5, reviewCount: 12 })
  })

  it('6. never derives a count from an unrelated value such as a listing id length or a formula on the score', () => {
    // No input field here resembles the previous fabrication formula
    // (score * 8 + id.length) -- this test exists to document that no
    // such derivation is possible with this function's signature at all.
    const result = deriveListingRatingDisplay({ averageRating: 5, reviewCount: 0 })
    expect(result.reviewCount).toBe(0)
    expect(result.show).toBe(false)
  })
})
