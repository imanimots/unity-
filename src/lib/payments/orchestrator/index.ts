/**
 * Financial Orchestrator -- coordinates Unity's financial workflows
 * without coupling the booking engine to any specific payment provider.
 * See docs/FINANCIAL_ORCHESTRATION.md for the architecture.
 *
 * Callable only from trusted server-side code (a service-role Supabase
 * client is required in OrchestratorContext -- the browser never has
 * that credential). Every function here composes existing payment-domain
 * RPCs; none writes to bookings, payments, or ledger_entries directly.
 */
export { prepareBookingFinancials } from './prepare-booking-financials'
export { authorizeBookingFinancials } from './authorize-booking-financials'
export { releaseDeposit } from './release-deposit'
export { captureDeposit } from './capture-deposit'
export { createMerchantPayout } from './create-merchant-payout'
export { prepareOrderFinancials } from './prepare-order-financials'
export { chargeOrderPayment, type ChargeOrderPaymentResult } from './charge-order-payment'
export { authorizeBarterDeposit, type AuthorizeBarterDepositResult } from './authorize-barter-deposit'
export { releaseBarterDeposit, type ReleaseBarterDepositResult } from './release-barter-deposit'
export { chargeBarterCashAdjustment, type ChargeBarterCashAdjustmentResult } from './charge-barter-cash-adjustment'
export { completeDisputeRefundWithProvider, type CompleteDisputeRefundResult } from './complete-dispute-refund'
export { reconcileProviderEvent, type NormalizedPaymentEvent, type ReconcileResult } from './reconcile-provider-event'
export {
  reconcileOrchestrationPayment,
  completeAsyncPaymentBusinessProgression,
  type OrchestrationEvidence,
  type ReconciliationOutcome,
  type BusinessProgressionOutcome,
} from './reconcile-orchestration-payment'
export { OrchestrationError, isRetryableOrchestrationError, type OrchestrationErrorCode } from './errors'
export { executeMerchantPayoutProviderAttempt, type ExecuteMerchantPayoutProviderAttemptResult } from './execute-merchant-payout-provider-attempt'
export { executeAffiliatePayoutProviderAttempt, type ExecuteAffiliatePayoutProviderAttemptResult } from './execute-affiliate-payout-provider-attempt'
export { reconcilePayoutProviderAttempt, type ReconcilePayoutProviderAttemptResult } from './reconcile-payout-provider-attempt'
export { applyPayoutWebhookPayload, type ApplyPayoutWebhookResult } from './payout-provider-attempt-shared'
export type {
  OrchestratorContext,
  PrepareBookingFinancialsResult,
  AuthorizeBookingFinancialsResult,
  ReleaseDepositResult,
  CaptureDepositResult,
  CreateMerchantPayoutResult,
} from './types'
