import type {
  CreateHostedCheckoutPaymentResponse,
  CapturePaymentResponse,
  CancelPaymentResponse,
  GetPaymentResponse,
  OrchestrationPaymentStatus,
} from './types'

/**
 * Pure response-shape parsers for Peach Orchestration (P5C).
 *
 * IMPORTANT, HONEST GAP: the exact response field name carrying the
 * Hosted Checkout shopper-redirect URL was never directly confirmed by
 * any of the (many) documentation fetches performed across P5B.2-R and
 * P5C -- every fetch describing the response only said "a URL to
 * redirect the shopper to" in prose, never quoting the literal JSON key.
 * Rather than hardcode a guessed field name for a live financial
 * redirect (which would fail silently/confusingly in sandbox if wrong),
 * extractRedirectUrl() checks a small, explicit set of plausible names
 * and throws a clear, distinctive error if none match -- fail loud, not
 * silent. This must be resolved with one direct sandbox response
 * inspection (or a successful further docs lookup) before this path is
 * exercised against a real sandbox call; see the P5C final report.
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

/**
 * Extracts the shopper-redirect URL from a Hosted Checkout creation
 * response. Never guesses a value from a single hardcoded field name --
 * see the file-level comment above.
 */
export function extractRedirectUrl(body: Record<string, unknown>): string {
  for (const field of REDIRECT_URL_FIELD_CANDIDATES) {
    const value = body[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  throw new UnrecognizedOrchestrationResponseError(
    `Orchestration Hosted Checkout response did not contain a recognized redirect-URL field (checked: ${REDIRECT_URL_FIELD_CANDIDATES.join(', ')}) -- verify the exact field name against sandbox/live API reference before enabling this path`
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
