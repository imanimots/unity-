/**
 * Peach Orchestration -- shared request/response shapes (P5C).
 *
 * Field names here are sourced from playground.peachpayments.com (the
 * official Orchestration interactive docs, distinct from the classic
 * developer.peachpayments.com portal -- see docs/PEACH_ORCHESTRATION.md
 * once written, and the P5B.2-R phase report for the exact citations),
 * confirmed by direct fetch during P5B.2-R/P5C:
 *   - POST /payments (create), POST /payments/{payment_id}/capture,
 *     POST /payments/{payment_id}/cancel, GET /payments/{payment_id},
 *     POST /refunds (not activated this phase -- P5E)
 *   - api-key header auth (not OAuth/bearer -- a genuinely different
 *     model from the classic, unused Checkout V2 scaffolding)
 *   - integer minor-unit amounts (92.00 ZAR -> 9200), never a decimal
 *     string
 *   - capture_method: 'manual' confirmed verbatim for preauthorisation;
 *     'automatic' used explicitly here for the ordinary leg even though
 *     it may also be Orchestration's own default, per this phase's own
 *     instruction to be explicit
 *   - 9-value payment status lifecycle confirmed verbatim
 *
 * One field is NOT confirmed by any fetch performed across P5B.2-R/P5C:
 * the exact response field name carrying the Hosted Checkout redirect
 * URL. See response-parsers.ts's own comment for how that gap is
 * handled -- defensively, never guessed silently.
 */

export type OrchestrationEnvironment = 'sandbox' | 'production'

export type OrchestrationCaptureMethod = 'automatic' | 'manual'

/**
 * Confirmed verbatim from playground.peachpayments.com/payment-states.
 * Not every value is reachable from every capture_method/flow, but all
 * nine are real, documented Orchestration states -- not invented here.
 */
export type OrchestrationPaymentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'requires_capture'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'partially_captured'

export interface CreateHostedCheckoutPaymentRequest {
  amount: number // integer minor units -- see amount.ts
  currency: string
  confirm: false
  payment_link: true
  capture_method: OrchestrationCaptureMethod
  return_url: string
  allowed_payment_method_types?: string[] // omitted/empty = all business-profile-enabled methods
  metadata?: Record<string, string>
}

export interface CreateHostedCheckoutPaymentResponse {
  payment_id: string
  status: OrchestrationPaymentStatus
  /**
   * The field actually carrying the shopper redirect URL was never
   * directly confirmed by any fetch performed this phase or the prior
   * one (four distinct attempts). response-parsers.ts checks a small,
   * explicit set of plausible names rather than trusting one guessed
   * name -- this type intentionally does not declare a single field for
   * it, forcing every caller through that defensive parser.
   */
  [key: string]: unknown
}

export interface CapturePaymentResponse {
  payment_id: string
  status: OrchestrationPaymentStatus
}

export interface CancelPaymentResponse {
  payment_id: string
  status: OrchestrationPaymentStatus
}

export interface GetPaymentResponse {
  payment_id: string
  status: OrchestrationPaymentStatus
  amount: number
  currency: string
}
