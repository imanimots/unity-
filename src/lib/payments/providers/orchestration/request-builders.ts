import { toMinorUnits } from './amount'
import type { CreateHostedCheckoutPaymentRequest, OrchestrationCaptureMethod } from './types'

/**
 * Pure request-shape builders for Peach Orchestration (P5C). No fetch()
 * here -- wiring into an actual HTTP call is client.ts's job, mirroring
 * the same separation-of-concerns already established by the classic
 * (unused-this-phase) peach/request-builders.ts.
 *
 * Field names confirmed live against playground.peachpayments.com
 * (P5B.2-R/P5C): amount, currency, confirm, payment_link, capture_method,
 * return_url, allowed_payment_method_types, metadata.
 */

export interface BuildHostedCheckoutPaymentParams {
  amount: string // decimal-string form of payments.amount, e.g. "92.00"
  currency: string
  captureMethod: OrchestrationCaptureMethod
  returnUrl: string
  /** Omit or leave empty to offer every payment method enabled on the business profile -- confirmed live as the documented "all enabled methods" behavior. */
  allowedPaymentMethodTypes?: string[]
  metadata?: Record<string, string>
}

export function buildHostedCheckoutPaymentRequest(params: BuildHostedCheckoutPaymentParams): CreateHostedCheckoutPaymentRequest {
  const request: CreateHostedCheckoutPaymentRequest = {
    amount: toMinorUnits(params.amount),
    currency: params.currency,
    confirm: false,
    payment_link: true,
    capture_method: params.captureMethod,
    return_url: params.returnUrl,
  }
  if (params.allowedPaymentMethodTypes && params.allowedPaymentMethodTypes.length > 0) {
    request.allowed_payment_method_types = params.allowedPaymentMethodTypes
  }
  if (params.metadata) {
    request.metadata = params.metadata
  }
  return request
}

/**
 * The ordinary rental/order charge leg -- automatic capture, no payment-
 * method restriction (business-profile-enabled methods only, per this
 * phase's own confirmed policy).
 */
export function buildOrdinaryPaymentRequest(params: {
  amount: string
  currency: string
  returnUrl: string
  metadata?: Record<string, string>
}): CreateHostedCheckoutPaymentRequest {
  return buildHostedCheckoutPaymentRequest({
    amount: params.amount,
    currency: params.currency,
    captureMethod: 'automatic',
    returnUrl: params.returnUrl,
    metadata: params.metadata,
  })
}

/**
 * The security-deposit leg -- manual capture (preauthorisation),
 * confirmed live as `"capture_method": "manual"`. This phase does not
 * additionally restrict `allowed_payment_method_types` to CARD: which
 * payment methods actually support preauthorisation was not confirmed
 * by any fetch performed (the Orchestration payment-methods page
 * documented refund capability per method, not preauthorisation
 * capability) -- restricting to an unconfirmed method list would risk
 * silently excluding a method that does support it, or claiming support
 * for one that doesn't. Left unrestricted here, with this gap explicitly
 * flagged in the phase report rather than guessed into the request.
 */
export function buildDepositAuthorisationRequest(params: {
  amount: string
  currency: string
  returnUrl: string
  metadata?: Record<string, string>
}): CreateHostedCheckoutPaymentRequest {
  return buildHostedCheckoutPaymentRequest({
    amount: params.amount,
    currency: params.currency,
    captureMethod: 'manual',
    returnUrl: params.returnUrl,
    metadata: params.metadata,
  })
}
