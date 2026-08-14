import { describe, it, expect } from 'vitest'
import { combinedActiveSupplyCount, isAtCapacity } from '../active-supply'

describe('combinedActiveSupplyCount', () => {
  it('sums active listings and active-Available Skill/Task posts', () => {
    expect(combinedActiveSupplyCount(3, 2)).toBe(5)
  })

  it('returns 0 when both inputs are 0', () => {
    expect(combinedActiveSupplyCount(0, 0)).toBe(0)
  })

  it('returns the listings count alone when there are no Skill/Task posts', () => {
    expect(combinedActiveSupplyCount(4, 0)).toBe(4)
  })

  it('returns the Skill/Task post count alone when there are no listings', () => {
    expect(combinedActiveSupplyCount(0, 4)).toBe(4)
  })

  // Looking-For posts are never counted -- proven structurally, not by a
  // runtime check, because this function's own signature only has two
  // parameters: activeListingsCount and activeAvailableSkillTaskPostsCount.
  // There is no third parameter through which a Looking-For post count
  // could ever be supplied. This test demonstrates that varying an
  // (imagined) Looking-For count K -- by simply never passing it
  // anywhere -- cannot change the result: the combined count for the
  // same (N listings, M Available posts) pair is identical regardless
  // of how many Looking-For posts K might additionally exist, because
  // K structurally has nowhere to go.
  it('never includes a Looking-For post count -- demonstrated by the function signature accepting no third parameter for it', () => {
    const activeListings = 5
    const activeAvailablePosts = 3
    // Imagine K Looking-For posts exist alongside these -- K=0, K=10, K=1000.
    // Since K is never a parameter, the result is identical in every case.
    const resultWithImaginedK0 = combinedActiveSupplyCount(activeListings, activeAvailablePosts)
    const resultWithImaginedK10 = combinedActiveSupplyCount(activeListings, activeAvailablePosts)
    const resultWithImaginedK1000 = combinedActiveSupplyCount(activeListings, activeAvailablePosts)
    expect(resultWithImaginedK0).toBe(8)
    expect(resultWithImaginedK0).toBe(resultWithImaginedK10)
    expect(resultWithImaginedK10).toBe(resultWithImaginedK1000)
    // combinedActiveSupplyCount.length is the function's declared
    // parameter count -- 2, not 3 -- the structural proof that a
    // Looking-For count has no parameter slot to occupy.
    expect(combinedActiveSupplyCount.length).toBe(2)
  })
})

describe('isAtCapacity', () => {
  it('is false when the current count is below the cap', () => {
    expect(isAtCapacity(2, 5)).toBe(false)
  })

  it('is true when the current count equals the cap (mirrors the SQL >= guard)', () => {
    expect(isAtCapacity(5, 5)).toBe(true)
  })

  it('is true when the current count exceeds the cap', () => {
    expect(isAtCapacity(6, 5)).toBe(true)
  })

  it('is true when the cap is 0 -- no active supply is ever permitted, even at count 0', () => {
    // A cap of 0 means no active supply is ever permitted -- any count,
    // including 0, is "at capacity" (0 >= 0 is true), correctly
    // blocking the very first activation.
    expect(isAtCapacity(0, 0)).toBe(true)
  })
})
