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
export { reconcileProviderEvent, type NormalizedPaymentEvent, type ReconcileResult } from './reconcile-provider-event'
export { OrchestrationError, isRetryableOrchestrationError, type OrchestrationErrorCode } from './errors'
export type {
  OrchestratorContext,
  PrepareBookingFinancialsResult,
  AuthorizeBookingFinancialsResult,
  ReleaseDepositResult,
  CaptureDepositResult,
  CreateMerchantPayoutResult,
} from './types'
