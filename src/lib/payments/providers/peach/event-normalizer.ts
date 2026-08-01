/**
 * Normalizes each of Peach's three distinct webhook payload shapes
 * (Checkout, OPPWA/card, Payouts -- see docs/PEACH_INTEGRATION.md
 * "Webhook mapping") into one small internal shape. Deliberately does
 * NOT resolve a Unity `bookingId` here -- that requires a database lookup
 * (payments.provider_reference = peachTransactionId), which is not a
 * pure function's job. The webhook route is the intended caller that
 * does that lookup before handing off to
 * reconcileProviderEvent()'s existing NormalizedPaymentEvent shape (see
 * src/lib/payments/orchestrator/reconcile-provider-event.ts) -- not built
 * this phase, since it needs the DB access this module deliberately
 * avoids so it stays fixture-testable offline.
 */
export interface NormalizedPeachEvent {
  source: 'checkout' | 'oppwa' | 'payouts'
  peachTransactionId: string
  merchantTransactionId: string | null
  eventType: string
  resultCode: string | null
}

interface CheckoutWebhookPayload {
  id?: string
  merchantTransactionId?: string
  type?: string
  result?: { code?: string }
}

export function normalizeCheckoutWebhookPayload(payload: unknown): NormalizedPeachEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as CheckoutWebhookPayload
  if (!p.id || !p.type) return null
  return {
    source: 'checkout',
    peachTransactionId: p.id,
    merchantTransactionId: p.merchantTransactionId ?? null,
    eventType: p.type,
    resultCode: p.result?.code ?? null,
  }
}

interface OppwaWebhookPayload {
  type?: string
  action?: string
  payload?: {
    id?: string
    merchantTransactionId?: string
    paymentType?: string
    result?: { code?: string }
  }
}

export function normalizeOppwaWebhookPayload(decryptedPayload: unknown): NormalizedPeachEvent | null {
  if (!decryptedPayload || typeof decryptedPayload !== 'object') return null
  const p = decryptedPayload as OppwaWebhookPayload
  const inner = p.payload
  if (!p.type || !inner?.id) return null
  return {
    source: 'oppwa',
    peachTransactionId: inner.id,
    merchantTransactionId: inner.merchantTransactionId ?? null,
    eventType: inner.paymentType ? `${p.type}:${inner.paymentType}` : p.type,
    resultCode: inner.result?.code ?? null,
  }
}

interface PayoutWebhookPayload {
  payoutId?: string
  status?: string
  resultCode?: string
}

export function normalizePayoutWebhookPayload(payload: unknown): NormalizedPeachEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as PayoutWebhookPayload
  if (!p.payoutId || !p.status) return null
  return {
    source: 'payouts',
    peachTransactionId: p.payoutId,
    merchantTransactionId: null,
    eventType: `payout:${p.status}`,
    resultCode: p.resultCode ?? null,
  }
}
