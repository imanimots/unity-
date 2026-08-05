export type BarterPaymentStatus =
  | 'pending'
  | 'authorised'
  | 'captured'
  | 'partially_captured'
  | 'released'
  | 'refunded'
  | 'partially_refunded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'chargeback'
  | null

export interface BarterDepositRequirement {
  payer: 'party_a' | 'party_b'
  status: BarterPaymentStatus
}

export interface BarterFinancialReadinessInput {
  /** 0, 1, or 2 entries -- one per required deposit payer (deposit_payer: 'party_a' | 'party_b' | 'both'). */
  depositRequirements: BarterDepositRequirement[]
  cashAdjustmentRequired: boolean
  cashAdjustmentStatus: BarterPaymentStatus
}

export type BarterFinancialReadinessState = 'no_payment_required' | 'awaiting_payment' | 'payment_failed' | 'financially_ready'

const READY_DEPOSIT_STATUSES: BarterPaymentStatus[] = ['authorised', 'captured', 'released']

/**
 * The one derived helper for barter financial readiness (Step 11 Phase
 * 4) -- mirrors src/lib/checkout/financial-readiness.ts's pure-derivation
 * shape, purpose-fit for barter's simpler per-payment-row model. Unlike
 * booking's dual rental+deposit workflow, a barter agreement has 0-2
 * independent deposit rows plus an optional cash-adjustment row, and
 * there is no financial_workflows table backing it (see
 * docs/BARTER_EXECUTION.md) -- readiness is always re-derived straight
 * from the payment rows, never persisted. Used identically by
 * mark_barter_progress() (server-authoritative, the real gate) and the
 * UI (only decides what to render).
 */
export function deriveBarterFinancialReadiness(input: BarterFinancialReadinessInput): BarterFinancialReadinessState {
  const { depositRequirements, cashAdjustmentRequired, cashAdjustmentStatus } = input

  if (depositRequirements.length === 0 && !cashAdjustmentRequired) return 'no_payment_required'

  const depositsReady = depositRequirements.every((d) => READY_DEPOSIT_STATUSES.includes(d.status))
  const cashReady = !cashAdjustmentRequired || cashAdjustmentStatus === 'captured'

  if (depositsReady && cashReady) return 'financially_ready'

  const anyFailed = depositRequirements.some((d) => d.status === 'failed') || (cashAdjustmentRequired && cashAdjustmentStatus === 'failed')
  if (anyFailed) return 'payment_failed'

  return 'awaiting_payment'
}

export const BARTER_FINANCIAL_READINESS_COPY: Record<BarterFinancialReadinessState, { label: string; description: string }> = {
  no_payment_required: { label: 'No payment required', description: 'This trade has no deposit or cash adjustment to settle.' },
  awaiting_payment: { label: 'Payment required', description: 'One or more required payments are still outstanding before this trade can proceed.' },
  payment_failed: { label: 'Payment failed', description: 'A required payment failed. Please retry to proceed.' },
  financially_ready: { label: 'Financially ready', description: 'All required payments are complete — this trade is ready to proceed.' },
}
