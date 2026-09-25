import { extractNextAction } from './response-parsers'
import type { OrchestrationNextAction } from './types'

/**
 * Peach Orchestration's native webhook envelope (P5D-A.1, confirmed
 * verbatim from playground.peachpayments.com/flows/webhooks.md): a JSON
 * body containing `event_id` (dedup identifier), `event_type` (e.g.
 * "payment_succeeded", "refund_created"), `content` (the full
 * payment/refund object), and `timestamp`. This is the authoritative
 * Orchestration event shape -- never a synthesized identifier
 * (sha256(rawBody), payment_id+status, etc.) once a delivery is
 * authenticated.
 *
 * Only `payment_id` and `status` inside `content` are required --
 * everything else (amount, currency, next_action, metadata) is
 * confirmed-but-optional evidence (P5D-A.1's own honesty discipline:
 * the full `content` schema was never enumerated by any documentation
 * fetch performed). Unknown top-level or content fields are silently
 * ignored, never rejected -- Peach adding a field later must not break
 * parsing.
 */

export interface OrchestrationWebhookContent {
  paymentId: string
  status: string
  amountMinorUnits?: number
  currency?: string
  nextAction?: OrchestrationNextAction
  metadata?: Record<string, unknown>
}

export interface OrchestrationWebhookEnvelope {
  eventId: string
  eventType: string
  timestamp?: string
  content: OrchestrationWebhookContent
}

export class MalformedOrchestrationWebhookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedOrchestrationWebhookError'
  }
}

/** Fails closed on anything structurally invalid -- never returns a partial envelope. */
export function parseOrchestrationWebhookEnvelope(rawBody: string): OrchestrationWebhookEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new MalformedOrchestrationWebhookError('webhook body was not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new MalformedOrchestrationWebhookError('webhook body was not a JSON object')
  }
  const record = parsed as Record<string, unknown>

  const eventId = record.event_id
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new MalformedOrchestrationWebhookError('webhook envelope missing required "event_id" string field')
  }
  const eventType = record.event_type
  if (typeof eventType !== 'string' || eventType.length === 0) {
    throw new MalformedOrchestrationWebhookError('webhook envelope missing required "event_type" string field')
  }
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined

  const contentRaw = record.content
  if (!contentRaw || typeof contentRaw !== 'object') {
    throw new MalformedOrchestrationWebhookError('webhook envelope missing required "content" object field')
  }
  const contentRecord = contentRaw as Record<string, unknown>

  const paymentId = contentRecord.payment_id
  if (typeof paymentId !== 'string' || paymentId.length === 0) {
    throw new MalformedOrchestrationWebhookError('webhook envelope content missing required "payment_id" string field')
  }
  const status = contentRecord.status
  if (typeof status !== 'string' || status.length === 0) {
    throw new MalformedOrchestrationWebhookError('webhook envelope content missing required "status" string field')
  }

  const amountMinorUnits = typeof contentRecord.amount === 'number' ? contentRecord.amount : undefined
  const currency = typeof contentRecord.currency === 'string' ? contentRecord.currency : undefined
  const nextAction = extractNextAction(contentRecord) ?? undefined
  const metadata = contentRecord.metadata && typeof contentRecord.metadata === 'object' ? (contentRecord.metadata as Record<string, unknown>) : undefined

  return {
    eventId,
    eventType,
    timestamp,
    content: { paymentId, status, amountMinorUnits, currency, nextAction, metadata },
  }
}

/**
 * Classifies a raw wire status into what the reconciliation service
 * needs to decide next -- never coerces an unrecognized value into a
 * known category (the `unknown` branch is exactly for a future status
 * Peach adds that this codebase hasn't seen yet; see P5D-A/A.1's own
 * "never guess" discipline). `cancelled` is deliberately its own
 * category rather than a fixed target -- resolving to `released` vs
 * `cancelled` requires the current payment's own context (payment_type,
 * current status), which this function has no access to; that
 * resolution belongs to reconcile-orchestration-payment.ts.
 */
export type OrchestrationStatusCategory =
  | { kind: 'no_transition' }
  | { kind: 'target'; target: 'authorised' | 'captured' | 'failed' | 'partially_captured' }
  | { kind: 'cancelled' }
  | { kind: 'unknown'; rawStatus: string }

export function categorizeOrchestrationStatus(status: string): OrchestrationStatusCategory {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'requires_customer_action':
    case 'processing':
      return { kind: 'no_transition' }
    case 'requires_capture':
      return { kind: 'target', target: 'authorised' }
    case 'succeeded':
      return { kind: 'target', target: 'captured' }
    case 'failed':
      return { kind: 'target', target: 'failed' }
    case 'partially_captured':
      return { kind: 'target', target: 'partially_captured' }
    case 'cancelled':
      return { kind: 'cancelled' }
    default:
      return { kind: 'unknown', rawStatus: status }
  }
}

/**
 * Broad event_type classification -- used only to recognize a refund
 * event well enough to report it as explicitly deferred (P5E owns
 * refund mutation; no RPC exists yet to transition refunds.status from
 * provider evidence -- P5D-A.1's own finding). Never drives a financial
 * transition by itself; `content.status` remains the actual signal for
 * payment events.
 */
export function isRefundEventType(eventType: string): boolean {
  return eventType.startsWith('refund_')
}
