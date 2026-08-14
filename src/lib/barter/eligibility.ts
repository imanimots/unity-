// Skills + Tasks under Barter -- pure TS mirror of the
// `barter_deposit_eligibility` read-only VIEW's formula (plan §22):
//
//   deposit_release_eligible_percent =
//     SUM(contribution_weight_percent x milestone_weight_percent / 100)
//     WHERE offer_item.offered_by = deposit_terms.payer_id
//       AND milestone.status = 'completed'
//
// This function intentionally receives only rows already scoped to one
// payer's contributions (the WHERE offered_by = payer_id join happens
// upstream, in the SQL view or the caller) and sums the effective
// weight of exactly the rows whose milestoneStatus is 'completed' --
// pending/active rows contribute zero.
//
// IMPORTANT -- release_basis is NOT a parameter here, deliberately.
// Per plan §21, `release_basis='full_on_completion'` deposits never
// enter this milestone-eligibility computation at all -- their eligible
// amount is binary (0% until overall completion, 100% at completion),
// handled entirely by a different code path. This function has no way
// to know or care about release_basis; it just sums whatever
// completed rows it is handed. The CALLER is responsible for excluding
// full_on_completion deposit rows before ever invoking this function
// (mirroring the view's own `WHERE release_basis = 'milestone_weighted'`
// scoping, plan §22) -- see the test file for a regression proving this
// boundary explicitly.
//
// Pure: no imports, no side effects.

export interface EligibilityRow {
  contributionWeightPercent: number
  milestoneWeightPercent: number
  milestoneStatus: 'pending' | 'active' | 'completed'
}

/** Sum of contributionWeightPercent x milestoneWeightPercent / 100
 * over rows whose milestoneStatus is 'completed' only. Zero
 * contribution from pending/active rows. */
export function computeEligiblePercent(rows: EligibilityRow[]): number {
  return rows
    .filter((row) => row.milestoneStatus === 'completed')
    .reduce((total, row) => total + (row.contributionWeightPercent * row.milestoneWeightPercent) / 100, 0)
}
