import type { MerchantSubscriptionPlan } from '@/types'

export interface MonthlyVolumeCents {
  salesVolumeCents: number
  rentalVolumeCents: number
}

export interface PlanCostBreakdown {
  planId: MerchantSubscriptionPlan['id']
  monthlyFeeCents: number
  salesCommissionCents: number
  rentalCommissionCents: number
  totalCostCents: number
}

/**
 * All money math here is integer cents and integer basis points --
 * never floating point. Rounds to the nearest cent per component
 * (banker's-rounding-free, plain round-half-up via Math.round, which is
 * the same rounding every other financial calculation in this codebase
 * already uses).
 */
function commissionCents(volumeCents: number, bps: number): number {
  return Math.round((volumeCents * bps) / 10000)
}

/** Barter is not a parameter here on purpose -- there is no volume input for it because its commission is always 0 on every plan, enforced by the plan model's own barter_commission_bps check constraint. */
export function computeMonthlyPlanCost(plan: MerchantSubscriptionPlan, volume: MonthlyVolumeCents): PlanCostBreakdown {
  const salesCommissionCents = commissionCents(volume.salesVolumeCents, plan.sales_commission_bps)
  const rentalCommissionCents = commissionCents(volume.rentalVolumeCents, plan.rental_commission_bps)
  return {
    planId: plan.id,
    monthlyFeeCents: plan.monthly_fee_cents,
    salesCommissionCents,
    rentalCommissionCents,
    totalCostCents: plan.monthly_fee_cents + salesCommissionCents + rentalCommissionCents,
  }
}

export interface CheapestPlanResult {
  cheapestPlanIds: string[]
  breakdowns: PlanCostBreakdown[]
  isTie: boolean
}

/** Computes cost under every given (active) plan and returns every plan tied at the minimum -- never picks an arbitrary "winner" on a tie. */
export function findCheapestPlans(plans: MerchantSubscriptionPlan[], volume: MonthlyVolumeCents): CheapestPlanResult {
  const breakdowns = plans.map((plan) => computeMonthlyPlanCost(plan, volume))
  const minCost = Math.min(...breakdowns.map((b) => b.totalCostCents))
  const cheapestPlanIds = breakdowns.filter((b) => b.totalCostCents === minCost).map((b) => b.planId)
  return { cheapestPlanIds, breakdowns, isTie: cheapestPlanIds.length > 1 }
}

/**
 * Only ever positive -- a tie or a more expensive candidate both yield
 * 0, never a negative "saving." Callers must not render a "you could
 * save" message when this returns 0.
 */
export function computeSavingsCents(currentPlanCostCents: number, candidatePlanCostCents: number): number {
  const savings = currentPlanCostCents - candidatePlanCostCents
  return savings > 0 ? savings : 0
}
