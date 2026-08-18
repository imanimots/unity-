import type { BarterDepositTerm, BarterOfferItem } from '@/types'

interface DepositEligibilityPanelLabels {
  title: string
  thisParty: string
  eligibleText: (amount: string) => string
  percentText: (percent: number, totalAmount: string) => string
}

interface DepositEligibilityPanelProps {
  depositTerms: BarterDepositTerm[]
  items: BarterOfferItem[]
  partyAId: string
  partyBId: string
  partyAName: string
  partyBName: string
  /**
   * Rendered both inside [locale] (via BarterAgreementView) AND directly
   * by admin/barter/[id]/page.tsx, which has no NextIntlClientProvider at
   * all. Server-resolved label overrides instead of useTranslations() --
   * admin call sites omit this and keep the English literals below.
   */
  labels?: DepositEligibilityPanelLabels
}

/**
 * Deposit-release eligibility display -- agreement.status === 'completed'
 * only (rendered conditionally by the caller). Computed from the same
 * authoritative accepted-offer rows the mark_barter_contribution_milestone_completed()
 * RPC itself derives eligibility from (§22's formula): for each
 * milestone_weighted deposit term, sum contribution_weight_percent x
 * milestone_weight_percent / 100 across that payer's completed
 * milestones. Purely a display computation -- no write side effect,
 * and by the time this ever renders the agreement is already fully
 * completed, so every deposit (full_on_completion or milestone_weighted)
 * has already released in full via confirm_barter_completion(); this
 * panel is a transparency/audit display of how the milestone-weighted
 * amount was earned, never a claim that anything further is pending.
 */
export function DepositEligibilityPanel({ depositTerms, items, partyAId, partyBId, partyAName, partyBName, labels }: DepositEligibilityPanelProps) {
  const milestoneWeighted = depositTerms.filter((d) => d.release_basis === 'milestone_weighted')
  if (milestoneWeighted.length === 0) return null

  function nameFor(payerId: string) {
    if (payerId === partyAId) return partyAName
    if (payerId === partyBId) return partyBName
    return labels?.thisParty ?? 'This party'
  }

  function eligiblePercentFor(payerId: string): number {
    const myItems = items.filter((i) => i.offered_by === payerId && (i.kind === 'skill' || i.kind === 'task'))
    let percent = 0
    for (const item of myItems) {
      for (const m of item.milestones ?? []) {
        if (m.status === 'completed') {
          percent += ((item.contribution_weight_percent ?? 0) * m.weight_percent) / 100
        }
      }
    }
    return Math.min(100, Math.round(percent * 100) / 100)
  }

  return (
    <div>
      <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">{labels?.title ?? 'Deposit eligibility'}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {milestoneWeighted.map((term) => {
          const percent = eligiblePercentFor(term.payer_id)
          const amount = Math.round(((term.amount * percent) / 100) * 100) / 100
          return (
            <div key={term.id} className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-4 bg-white dark:bg-[#1A1010]">
              <p className="text-xs text-[#9B8B85] mb-1">{nameFor(term.payer_id)}&apos;s deposit</p>
              <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                {labels ? labels.eligibleText(`R${amount.toFixed(2)}`) : `R${amount.toFixed(2)} of your deposit is now eligible for release`}
              </p>
              <p className="text-xs text-[#9B8B85] mt-1">
                {labels ? labels.percentText(percent, `R${term.amount.toFixed(2)}`) : `${percent}% of milestone-weighted obligations completed · total deposit R${term.amount.toFixed(2)}`}
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
