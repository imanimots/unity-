import type {
  CreateHostedCheckoutPaymentResponse,
  CapturePaymentResponse,
  CancelPaymentResponse,
  GetPaymentResponse,
  OrchestrationPaymentStatus,
  OrchestrationNextAction,
} from './types'

/**
 * Pure response-shape parsers for Peach Orchestration (P5C, corrected
 * P5D-B).
 *
 * P5C's own honest gap -- the exact response field carrying the Hosted
 * Checkout shopper-redirect URL was never directly confirmed -- is now
 * resolved: playground.peachpayments.com/concepts/three-ds-next-action
 * confirms verbatim the documented, nested shape is
 * `next_action.redirect_to_url` (populated exactly when
 * `next_action.type === 'redirect_to_url'`, e.g.
 * `"redirect_to_url": "https://app.sandbox-next.peachpayments.com/api/payments/redirect/pay_.../..."`),
 * not a guessed top-level field. extractRedirectUrl() now prefers that
 * documented shape first. The original top-level candidate list is kept
 * only as a defensive fallback for a response that omits `next_action`
 * entirely -- it can never override a `next_action` that IS present
 * (see the function body).
 */

const REDIRECT_URL_FIELD_CANDIDATES = ['redirect_url', 'checkout_url', 'hosted_checkout_url', 'url'] as const

export class UnrecognizedOrchestrationResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnrecognizedOrchestrationResponseError'
  }
}

function assertPaymentId(body: Record<string, unknown>): string {
  const value = body.payment_id
  if (typeof value !== 'string' || value.length === 0) {
    throw new UnrecognizedOrchestrationResponseError('Orchestration response did not contain a "payment_id" string field')
  }
  return value
}

function assertStatus(body: Record<string, unknown>): OrchestrationPaymentStatus {
  const value = body.status
  if (typeof value !== 'string') {
    throw new UnrecognizedOrchestrationResponseError('Orchestration response did not contain a "status" string field')
  }
  return value as OrchestrationPaymentStatus
}

/** Extracts `next_action` if present and shaped as documented (has a string `type`); otherwise null. */
export function extractNextAction(body: Record<string, unknown>): OrchestrationNextAction | null {
  const value = body.next_action
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string') return null
  return record as unknown as OrchestrationNextAction
}

/**
 * Extracts the shopper-redirect URL. Prefers the documented nested
 * `next_action.redirect_to_url` shape (confirmed P5D-B -- see file
 * comment); an unsupported `next_action.type` (three_ds_invoke,
 * invoke_hidden_iframe, redirect_inside_popup, or a future value) fails
 * closed with a distinct error naming the type, rather than silently
 * falling through to a guessed field -- Unity's Hosted Checkout flow
 * only ever expects `redirect_to_url`. Only when `next_action` is
 * entirely absent does this fall back to the original top-level
 * candidate field names, for a response shape that predates/omits the
 * documented representation -- that fallback can never override a
 * present `next_action`.
 */
export function extractRedirectUrl(body: Record<string, unknown>): string {
  const nextAction = extractNextAction(body)
  if (nextAction) {
    if (nextAction.type === 'redirect_to_url') {
      const url = nextAction.redirect_to_url
      if (typeof url === 'string' && url.length > 0) return url
      throw new UnrecognizedOrchestrationResponseError(
        'Orchestration response\'s next_action.type was "redirect_to_url" but next_action.redirect_to_url was missing or empty'
      )
    }
    throw new UnrecognizedOrchestrationResponseError(
      `Orchestration response's next_action.type "${nextAction.type}" is not a supported redirect action for Unity's Hosted Checkout flow`
    )
  }

  for (const field of REDIRECT_URL_FIELD_CANDIDATES) {
    const value = body[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  throw new UnrecognizedOrchestrationResponseError(
    `Orchestration Hosted Checkout response did not contain next_action.redirect_to_url or any recognized top-level redirect-URL field (checked: ${REDIRECT_URL_FIELD_CANDIDATES.join(', ')})`
  )
}

export function parseCreateHostedCheckoutPaymentResponse(body: unknown): CreateHostedCheckoutPaymentResponse {
  if (!body || typeof body !== 'object') {
    throw new UnrecognizedOrchestrationResponseError('Orchestration create-payment response was not a JSON object')
  }
  const record = body as Record<string, unknown>
  const paymentId = assertPaymentId(record)
  const status = assertStatus(record)
  return { ...record, payment_id: paymentId, status }
}

export function parseCapturePaymentResponse(body: unknown): CapturePaymentResponse {
  if (!body || typeof body !== 'object') {
    throw new UnrecognizedOrchestrationResponseError('Orchestration capture response was not a JSON object')
  }
  const record = body as Record<string, unknown>
  return { payment_id: assertPaymentId(record), status: assertStatus(record) }
}

export function parseCancelPaymentResponse(body: unknown): CancelPaymentResponse {
  if (!body || typeof body !== 'object') {
    throw new UnrecognizedOrchestrationResponseError('Orchestration cancel response was not a JSON object')
  }
  const record = body as Record<string, unknown>
  return { payment_id: assertPaymentId(record), status: assertStatus(record) }
}

export function parseGetPaymentResponse(body: unknown): GetPaymentResponse {
  if (!body || typeof body !== 'object') {
    throw new UnrecognizedOrchestrationResponseError('Orchestration get-payment response was not a JSON object')
  }
  const record = body as Record<string, unknown>
  const amount = record.amount
  const currency = record.currency
  if (typeof amount !== 'number') {
    throw new UnrecognizedOrchestrationResponseError('Orchestration get-payment response did not contain a numeric "amount" field')
  }
  if (typeof currency !== 'string') {
    throw new UnrecognizedOrchestrationResponseError('Orchestration get-payment response did not contain a "currency" string field')
  }
  return { payment_id: assertPaymentId(record), status: assertStatus(record), amount, currency }
}
