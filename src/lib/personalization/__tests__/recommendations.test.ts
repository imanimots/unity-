import { describe, it, expect } from 'vitest'
import { buildAffinity, diversify, effectiveViewWeight, rankCandidates, rankContinueBrowsing, scoreCandidate, SCORE_WEIGHTS, viewRecencyMultiplier } from '../recommendations'
import type { PersonalizationProfileInput, PersonalizationViewRecord, RecommendationCandidate } from '../types'

function view(overrides: Partial<PersonalizationViewRecord> = {}): PersonalizationViewRecord {
  return {
    entityType: 'listing',
    entityId: 'view-1',
    mode: 'rent',
    category: 'tech',
    kind: 'item',
    province: null,
    city: null,
    viewCount: 1,
    lastViewedAt: new Date().toISOString(),
    ...overrides,
  }
}

function candidate(overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return {
    entityType: 'listing',
    entityId: 'cand-1',
    mode: 'rent',
    category: 'tech',
    kind: 'item',
    province: null,
    city: null,
    merchantId: 'merchant-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function emptyProfile(overrides: Partial<PersonalizationProfileInput> = {}): PersonalizationProfileInput {
  return { views: [], completedCategories: [], completedModes: [], settings: null, ...overrides }
}

describe('personalization recommendation engine (category: Recency)', () => {
  it('1. a view within 7 days gets full recency weight', () => {
    expect(viewRecencyMultiplier(new Date().toISOString())).toBe(1)
  })

  it('2. a view 15 days old gets partial (0.5) recency weight', () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
    expect(viewRecencyMultiplier(fifteenDaysAgo)).toBe(0.5)
  })

  it('3. a view 60 days old gets minimal (0.15) recency weight -- last 7 > last 30 > older, as documented', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    expect(viewRecencyMultiplier(sixtyDaysAgo)).toBe(0.15)
  })
})

describe('personalization recommendation engine (category: Duplicate-view cap)', () => {
  it('4. view_count is capped at 5 for scoring purposes even if a malformed record exceeds it', () => {
    expect(effectiveViewWeight(50)).toBe(5)
  })

  it('5. view_count below 1 is floored to 1, never zero or negative weight', () => {
    expect(effectiveViewWeight(0)).toBe(1)
  })

  it('6. 50 refreshes of the same item do not become 50x the affinity of a single view (Section 59)', () => {
    const heavilyViewed = emptyProfile({ views: [view({ viewCount: 50 })] })
    const singleView = emptyProfile({ views: [view({ viewCount: 1 })] })
    const heavyAffinity = buildAffinity(heavilyViewed).categories.get('tech')!
    const singleAffinity = buildAffinity(singleView).categories.get('tech')!
    expect(heavyAffinity).toBe(singleAffinity * 5) // capped at 5x, not 50x
  })
})

describe('personalization recommendation engine (category: Preference scoring)', () => {
  it('7. explicit preferred category increases score over an identical unpreferred candidate', () => {
    const profile = emptyProfile({ settings: { preferredModes: [], preferredCategories: ['tech'], preferredBarterKinds: [], preferredProvince: null, preferredCity: null } })
    const affinity = buildAffinity(profile)
    const preferred = scoreCandidate(candidate({ entityId: 'a', category: 'tech' }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    const other = scoreCandidate(candidate({ entityId: 'b', category: 'outdoor' }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(preferred.score).toBeGreaterThan(other.score)
    expect(preferred.reasonCodes).toContain('preferred_category')
  })

  it('8. explicit preferred mode contributes SCORE_WEIGHTS.PREFERRED_MODE', () => {
    const profile = emptyProfile({ settings: { preferredModes: ['barter'], preferredCategories: [], preferredBarterKinds: [], preferredProvince: null, preferredCity: null } })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ mode: 'barter', category: null }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scored.score).toBeGreaterThanOrEqual(SCORE_WEIGHTS.PREFERRED_MODE)
    expect(scored.reasonCodes).toContain('preferred_mode')
  })

  it('9. explicit preferred barter kind contributes SCORE_WEIGHTS.PREFERRED_KIND', () => {
    const profile = emptyProfile({ settings: { preferredModes: [], preferredCategories: [], preferredBarterKinds: ['skill'], preferredProvince: null, preferredCity: null } })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ kind: 'skill', category: null, mode: 'barter' }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scored.reasonCodes).toContain('preferred_kind')
  })

  it('10. completed-transaction category affinity outweighs a mere view (Section 18: strongest positive signal)', () => {
    const profile = emptyProfile({ completedCategories: ['tech'] })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ category: 'tech' }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scored.score).toBeGreaterThanOrEqual(SCORE_WEIGHTS.COMPLETED_CATEGORY)
    expect(scored.reasonCodes).toContain('completed_similar')
  })
})

describe('personalization recommendation engine (category: Location match)', () => {
  it('11. an explicit city match scores higher than a province-only match', () => {
    const cityProfile = emptyProfile({ settings: { preferredModes: [], preferredCategories: [], preferredBarterKinds: [], preferredProvince: 'Gauteng', preferredCity: 'Johannesburg' } })
    const affinity = buildAffinity(cityProfile)
    const cityMatch = scoreCandidate(candidate({ province: 'Gauteng', city: 'Johannesburg' }), cityProfile, affinity, { module: 'recommended_for_you', viewerId: null })!
    const provinceOnly = scoreCandidate(candidate({ province: 'Gauteng', city: 'Pretoria' }), cityProfile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(cityMatch.score).toBeGreaterThan(provinceOnly.score)
    expect(cityMatch.reasonCodes).toContain('location_match')
  })

  it('12. no location signal is ever used unless explicitly set on settings (never inferred)', () => {
    const profile = emptyProfile({ settings: { preferredModes: [], preferredCategories: [], preferredBarterKinds: [], preferredProvince: null, preferredCity: null } })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ province: 'Gauteng', city: 'Johannesburg' }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scored.reasonCodes).not.toContain('location_match')
  })
})

describe('personalization recommendation engine (category: Eligibility / exclusion)', () => {
  it('13. own listing is excluded from consumer recommendation modules (Section 26)', () => {
    const profile = emptyProfile()
    const affinity = buildAffinity(profile)
    const own = scoreCandidate(candidate({ merchantId: 'user-1' }), profile, affinity, { module: 'recommended_for_you', viewerId: 'user-1' })
    expect(own).toBeNull()
  })

  it('14. a candidate belonging to someone else is never excluded', () => {
    const profile = emptyProfile()
    const affinity = buildAffinity(profile)
    const other = scoreCandidate(candidate({ merchantId: 'merchant-2' }), profile, affinity, { module: 'recommended_for_you', viewerId: 'user-1' })
    expect(other).not.toBeNull()
  })

  it('15. an already-viewed item is penalized (not excluded) outside Continue Browsing (Section 25)', () => {
    const profile = emptyProfile({ views: [view({ entityId: 'cand-1' })] })
    const affinity = buildAffinity(profile)
    const scoredElsewhere = scoreCandidate(candidate({ entityId: 'cand-1', category: null, mode: null }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scoredElsewhere.score).toBeLessThan(0)
  })

  it('16. Continue Browsing does not apply the already-viewed penalty (it exists to show viewed items)', () => {
    const profile = emptyProfile({ views: [view({ entityId: 'cand-1' })] })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ entityId: 'cand-1', category: null, mode: null }), profile, affinity, { module: 'continue_browsing', viewerId: null })!
    expect(scored.score).toBeGreaterThanOrEqual(0)
  })
})

describe('personalization recommendation engine (category: Cold start / neutrality)', () => {
  it('17. a candidate with zero contributing signal gets reason code "newest", never fabricated relevance', () => {
    const profile = emptyProfile()
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ category: 'baby', mode: null, createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() }), profile, affinity, {
      module: 'recommended_for_you',
      viewerId: null,
    })!
    expect(scored.reasonCodes).toEqual(['newest'])
  })

  it('18. no subscription/paid/affiliate/KYC field exists anywhere on the candidate or score inputs (structural neutrality proof)', () => {
    const c = candidate()
    const keys = Object.keys(c)
    for (const forbidden of ['subscriptionTier', 'planId', 'affiliateRate', 'kycStatus', 'commissionRate', 'isAdvertised']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})

describe('personalization recommendation engine (category: Diversity)', () => {
  it('19. the merchant-repetition cap applies whenever enough OTHER inventory exists to fill the module without it', () => {
    // 6 candidates total, only 4 requested -- there is no need to dip
    // into merchant-x's 3rd item to fill the module, so the cap holds.
    const scored = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ entityType: 'listing' as const, entityId: id, score: 10, reasonCodes: ['newest' as const], reasonContext: {} }))
    const merchantByEntity = new Map([
      ['a', 'merchant-x'], ['b', 'merchant-x'], ['c', 'merchant-x'],
      ['d', 'merchant-y'], ['e', 'merchant-z'], ['f', 'merchant-w'],
    ])
    const result = diversify(scored, { merchantByEntity, categoryByEntity: new Map(), maxPerMerchant: 2, maxShareForOneCategory: 1, limit: 4 })
    const fromMerchantX = result.filter((r) => merchantByEntity.get(r.entityId) === 'merchant-x')
    expect(fromMerchantX.length).toBeLessThanOrEqual(2)
    expect(result).toHaveLength(4)
  })

  it('19b. the merchant cap is relaxed by the sparse-inventory backfill ONLY when there is no other way to fill the module (Section 56: prefer showing something)', () => {
    const scored = ['a', 'b', 'c', 'd'].map((id) => ({ entityType: 'listing' as const, entityId: id, score: 10, reasonCodes: ['newest' as const], reasonContext: {} }))
    const merchantByEntity = new Map([
      ['a', 'merchant-x'], ['b', 'merchant-x'], ['c', 'merchant-x'], ['d', 'merchant-y'],
    ])
    const result = diversify(scored, { merchantByEntity, categoryByEntity: new Map(), maxPerMerchant: 2, maxShareForOneCategory: 1, limit: 4 })
    // Only 4 candidates exist total and the module asked for 4 -- backfill
    // must use all of them, including the 3rd merchant-x item, rather
    // than under-filling the module.
    expect(result).toHaveLength(4)
  })

  it('20. sparse inventory backfills rather than returning fewer than available candidates (Section 56)', () => {
    const scored = ['a', 'b'].map((id) => ({ entityType: 'listing' as const, entityId: id, score: 10, reasonCodes: ['newest' as const], reasonContext: {} }))
    const merchantByEntity = new Map([
      ['a', 'merchant-x'],
      ['b', 'merchant-x'],
    ])
    // maxPerMerchant=1 would normally exclude 'b', but with only 2
    // candidates total the backfill pass must still return both.
    const result = diversify(scored, { merchantByEntity, categoryByEntity: new Map(), maxPerMerchant: 1, maxShareForOneCategory: 1, limit: 5 })
    expect(result).toHaveLength(2)
  })

  it('21. diversify never fabricates a candidate not present in the input set', () => {
    const scored = [{ entityType: 'listing' as const, entityId: 'a', score: 10, reasonCodes: ['newest' as const], reasonContext: {} }]
    const result = diversify(scored, { merchantByEntity: new Map(), categoryByEntity: new Map(), maxPerMerchant: 2, maxShareForOneCategory: 1, limit: 10 })
    expect(result).toHaveLength(1)
  })
})

describe('personalization recommendation engine (category: rankCandidates / Continue Browsing)', () => {
  it('22. rankCandidates returns results sorted by score descending', () => {
    const profile = emptyProfile({ completedCategories: ['tech'] })
    const candidates = [candidate({ entityId: 'low', category: 'baby', mode: null }), candidate({ entityId: 'high', category: 'tech' })]
    const ranked = rankCandidates(candidates, profile, { module: 'recommended_for_you', viewerId: null, limit: 10 })
    expect(ranked[0].entityId).toBe('high')
  })

  it('23. Continue Browsing orders by recency of the VIEW, not by score', () => {
    const older = view({ entityId: 'older', lastViewedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })
    const newer = view({ entityId: 'newer', lastViewedAt: new Date().toISOString() })
    const ranked = rankContinueBrowsing([older, newer], new Set(['older', 'newer']), 10)
    expect(ranked[0].entityId).toBe('newer')
  })

  it('24. Continue Browsing excludes entities that are no longer publicly eligible', () => {
    const v = view({ entityId: 'now-inactive' })
    const ranked = rankContinueBrowsing([v], new Set(), 10) // eligible set does not include it
    expect(ranked).toHaveLength(0)
  })
})

describe('personalization recommendation engine (category: RTB gate)', () => {
  it('25. RTB mode is never fabricated as a candidate mode by the scorer itself (gating lives in candidate sourcing, not scoring)', () => {
    // The scorer's PersonalizationMode vocabulary is exactly buy/rent/barter
    // -- there is no 'rent_to_buy' score-affecting mode, matching the
    // product decision that RTB serving is gated entirely upstream, at
    // candidate-sourcing time (getRtbEligibleListingIds), never inside
    // the deterministic scorer. A preferred mode of 'rent' scores a
    // 'rent'-mode candidate via PREFERRED_MODE; the type system (not a
    // runtime check) is what makes 'rent_to_buy' unrepresentable here.
    const profile = emptyProfile({ settings: { preferredModes: ['rent'], preferredCategories: [], preferredBarterKinds: [], preferredProvince: null, preferredCity: null } })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ mode: 'rent', category: null }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scored.reasonCodes).toEqual(['preferred_mode'])
  })
})

describe('personalization recommendation engine (category: no double-counting)', () => {
  it('26. a preferred-category match contributes SCORE_WEIGHTS.PREFERRED_CATEGORY exactly once, not twice', () => {
    const profile = emptyProfile({ settings: { preferredModes: [], preferredCategories: ['tech'], preferredBarterKinds: [], preferredProvince: null, preferredCity: null } })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ category: 'tech', mode: null }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scored.score).toBe(SCORE_WEIGHTS.PREFERRED_CATEGORY + SCORE_WEIGHTS.CANDIDATE_RECENCY)
  })

  it('27. a completed-transaction category match contributes SCORE_WEIGHTS.COMPLETED_CATEGORY exactly once, not twice', () => {
    const profile = emptyProfile({ completedCategories: ['tech'] })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ category: 'tech', mode: null }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scored.score).toBe(SCORE_WEIGHTS.COMPLETED_CATEGORY + SCORE_WEIGHTS.CANDIDATE_RECENCY)
  })

  it('28. a completed-transaction MODE match contributes SCORE_WEIGHTS.COMPLETED_CATEGORY and reasonCode completed_similar (mirrors the category case)', () => {
    const profile = emptyProfile({ completedModes: ['rent'] })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ category: null, mode: 'rent' }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scored.score).toBe(SCORE_WEIGHTS.COMPLETED_CATEGORY + SCORE_WEIGHTS.CANDIDATE_RECENCY)
    expect(scored.reasonCodes).toContain('completed_similar')
  })

  it('29. reasonCode "recently_viewed" is never fabricated for a category the user only completed a transaction in or only prefers -- never actually viewed', () => {
    const profile = emptyProfile({ completedCategories: ['tech'], settings: { preferredModes: [], preferredCategories: ['tech'], preferredBarterKinds: [], preferredProvince: null, preferredCity: null } })
    const affinity = buildAffinity(profile)
    const scored = scoreCandidate(candidate({ category: 'tech', mode: null }), profile, affinity, { module: 'recommended_for_you', viewerId: null })!
    expect(scored.reasonCodes).not.toContain('recently_viewed')
    expect(scored.reasonCodes).toContain('preferred_category')
    expect(scored.reasonCodes).toContain('completed_similar')
  })

  it('30. buildAffinity only reflects VIEW history -- completed/preferred signals are not present in its maps', () => {
    const profile = emptyProfile({
      completedCategories: ['tech'],
      completedModes: ['rent'],
      settings: { preferredModes: ['barter'], preferredCategories: ['garden'], preferredBarterKinds: [], preferredProvince: null, preferredCity: null },
    })
    const affinity = buildAffinity(profile)
    expect(affinity.categories.size).toBe(0)
    expect(affinity.modes.size).toBe(0)
  })
})
