import { describe, it, expect } from 'vitest'
import { computeEligiblePercent, type EligibilityRow } from '../eligibility'

describe('computeEligiblePercent', () => {
  it('returns 0 when zero milestones are completed', () => {
    const rows: EligibilityRow[] = [
      { contributionWeightPercent: 100, milestoneWeightPercent: 50, milestoneStatus: 'pending' },
      { contributionWeightPercent: 100, milestoneWeightPercent: 50, milestoneStatus: 'active' },
    ]
    expect(computeEligiblePercent(rows)).toBe(0)
  })

  it('returns 100 when all milestones (summing correctly) are completed', () => {
    const rows: EligibilityRow[] = [
      { contributionWeightPercent: 100, milestoneWeightPercent: 60, milestoneStatus: 'completed' },
      { contributionWeightPercent: 100, milestoneWeightPercent: 40, milestoneStatus: 'completed' },
    ]
    expect(computeEligiblePercent(rows)).toBe(100)
  })

  it('returns a correct partial percent when only some milestones are completed', () => {
    const rows: EligibilityRow[] = [
      { contributionWeightPercent: 100, milestoneWeightPercent: 60, milestoneStatus: 'completed' },
      { contributionWeightPercent: 100, milestoneWeightPercent: 40, milestoneStatus: 'pending' },
    ]
    expect(computeEligiblePercent(rows)).toBe(60)
  })

  it('correctly weights a two-level (contribution x milestone) partial scenario', () => {
    // One contribution at 50% of the offer side, its first milestone
    // (40% of that contribution) completed, its second (60%) not.
    const rows: EligibilityRow[] = [
      { contributionWeightPercent: 50, milestoneWeightPercent: 40, milestoneStatus: 'completed' },
      { contributionWeightPercent: 50, milestoneWeightPercent: 60, milestoneStatus: 'pending' },
    ]
    // 50 * 40 / 100 = 20% eligible so far.
    expect(computeEligiblePercent(rows)).toBe(20)
  })

  it('sums across multiple contributions, only counting each one\'s completed milestones', () => {
    const rows: EligibilityRow[] = [
      // Contribution A: 30% of offer side, one 100%-weight milestone, completed.
      { contributionWeightPercent: 30, milestoneWeightPercent: 100, milestoneStatus: 'completed' },
      // Contribution B: 70% of offer side, two milestones, only the first (25%) completed.
      { contributionWeightPercent: 70, milestoneWeightPercent: 25, milestoneStatus: 'completed' },
      { contributionWeightPercent: 70, milestoneWeightPercent: 75, milestoneStatus: 'active' },
    ]
    // 30*100/100 + 70*25/100 = 30 + 17.5 = 47.5
    expect(computeEligiblePercent(rows)).toBeCloseTo(47.5, 10)
  })

  it('returns 0 for an empty row list', () => {
    expect(computeEligiblePercent([])).toBe(0)
  })

  // Plan §21/§22: release_basis='full_on_completion' deposits never
  // enter this milestone-eligibility computation at all -- their
  // eligible amount is binary (0% until overall completion, 100% at
  // completion), handled by a wholly separate code path
  // (confirm_barter_completion()'s existing full-release trigger).
  // This function itself has no release_basis parameter anywhere in
  // its signature or body -- it structurally cannot know or care which
  // release basis the rows it's given belong to. It just sums
  // whatever completed rows are handed to it. Proving this means
  // proving the CALLER, not this function, is responsible for
  // excluding full_on_completion rows before calling it -- which we
  // demonstrate by showing this function computes the exact same
  // result regardless of what we'd have labelled the rows'
  // release_basis, because it was never asked.
  it('has no release_basis concept -- it just sums whatever completed rows it is given, proving the caller must pre-filter full_on_completion rows', () => {
    // Two milestone_weighted-style rows, one completed.
    const milestoneWeightedOnly: EligibilityRow[] = [
      { contributionWeightPercent: 100, milestoneWeightPercent: 50, milestoneStatus: 'completed' },
      { contributionWeightPercent: 100, milestoneWeightPercent: 50, milestoneStatus: 'pending' },
    ]
    // If a caller mistakenly failed to exclude a full_on_completion
    // deposit's rows before calling this function, nothing in the
    // EligibilityRow shape or this function's logic would catch it --
    // the row would be summed identically to a genuine
    // milestone_weighted row with the same weights/status. This test
    // documents that fact: appending an "extra" completed row (which,
    // in the real system, must never be a full_on_completion row --
    // the caller's job, not this function's) changes the result in
    // exactly the same additive way a legitimate milestone_weighted
    // row would, because the function has no field to distinguish them.
    const withExtraRow: EligibilityRow[] = [...milestoneWeightedOnly, { contributionWeightPercent: 20, milestoneWeightPercent: 100, milestoneStatus: 'completed' }]

    expect(computeEligiblePercent(milestoneWeightedOnly)).toBe(50)
    expect(computeEligiblePercent(withExtraRow)).toBe(70)
    // The EligibilityRow type itself has no release_basis field -- this
    // is enforced at compile time, not just by this runtime assertion.
  })
})
