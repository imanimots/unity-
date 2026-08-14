// Skills + Tasks under Barter -- pure client-side mirror of the
// two-level weighting formula described in the architecture plan
// (§17-18): a contribution's weight_percent values (across all of one
// party's kind IN ('skill','task') rows in one offer) must SUM to 100,
// and each contribution's own milestones must independently SUM to
// 100. Effective weight for eligibility purposes (§18, §22) is
// contribution_weight_percent x milestone_weight_percent / 100.
//
// This module deliberately duplicates (mirrors), rather than imports,
// the authoritative server-side validation -- the RPC
// (propose_barter()/counter_barter_offer()) remains the sole
// enforcement point. This is a testable specification used for
// client-side pre-submit validation (e.g. "these percentages must add
// up to 100 before you can submit") and as a documented, regression-
// tested description of the formula.
//
// Pure: no imports, no side effects.

/** Simple sum of weight_percent across a list of items (contributions
 * within a party, or milestones within a contribution). Used to
 * client-side-validate "must sum to 100" before submit. */
export function sumWeightPercent(items: { weight_percent: number }[]): number {
  return items.reduce((total, item) => total + item.weight_percent, 0)
}

/** Effective (performance/completion) weight of one milestone within
 * one contribution, as a percentage of the whole offer side --
 * contributionWeightPercent x milestoneWeightPercent / 100. Never a
 * rand value -- see plan §18. */
export function effectiveWeight(contributionWeightPercent: number, milestoneWeightPercent: number): number {
  return (contributionWeightPercent * milestoneWeightPercent) / 100
}
