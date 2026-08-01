import type { PeachPaymentsApiConfig, PeachPayoutsConfig } from './config'

/**
 * Pure request-shape builders -- given Unity's own input types (from
 * ../../provider.ts) and loaded config, produce exactly the JSON body
 * Peach's documented endpoints expect. None of these perform a fetch();
 * wiring one into an actual HTTP call is Phase 2E work. Field names and
 * shapes are sourced from the official reference pages cited in
 * docs/PEACH_INTEGRATION.md.
 */

function formatAmount(amount: number): string {
  // Payments API v2 wants a decimal string with exactly 2 places, no
  // leading zeros (docs/reference/payment.md) -- distinct from the
  // Payouts API, which wants an integer number of cents (see
  // buildPayoutRequest below). Mixing these up is a genuine, easy 100x
  // bug -- kept as two separate, narrowly-named functions on purpose
  // rather than one shared "amount formatter".
  return amount.toFixed(2)
}

export interface PeachChargeRequest {
  authentication: { entityId: string; userId: string; password: string }
  merchantTransactionId: string
  amount: string
  currency: string
  paymentBrand: string
  paymentType: 'DB'
  shopperResultUrl?: string
}

/**
 * Rental charge -- POST /payments (Payments API v2). Covers every Peach
 * payment method (card, EFT, wallet, BNPL, ...), not just cards, since
 * DB is a plain debit with no hold semantics.
 */
export function buildRentalChargeRequest(params: {
  config: PeachPaymentsApiConfig
  merchantTransactionId: string
  amount: number
  currency: string
  paymentBrand: string
  shopperResultUrl?: string
}): PeachChargeRequest {
  return {
    authentication: { entityId: params.config.entityId, userId: params.config.userId, password: params.config.password },
    merchantTransactionId: params.merchantTransactionId,
    amount: formatAmount(params.amount),
    currency: params.currency,
    paymentBrand: params.paymentBrand,
    paymentType: 'DB',
    ...(params.shopperResultUrl ? { shopperResultUrl: params.shopperResultUrl } : {}),
  }
}

export interface PeachRefundRequest {
  authentication: { entityId: string; userId: string; password: string }
  amount: string
  currency: string
  paymentType: 'RF'
}

/** POST /payments/{uniqueId} with paymentType=RF -- full or partial, single `amount` field, no batch shape. */
export function buildRefundRequest(params: { config: PeachPaymentsApiConfig; amount: number; currency: string }): PeachRefundRequest {
  return {
    authentication: { entityId: params.config.entityId, userId: params.config.userId, password: params.config.password },
    amount: formatAmount(params.amount),
    currency: params.currency,
    paymentType: 'RF',
  }
}

export interface PeachCardCaptureOrReversalRequest {
  paymentType: 'CP' | 'RV'
}

/**
 * Capture (CP) or reversal/void (RV) of a deposit's PA -- POST
 * /v1/payments/{id} against the card/backoffice API, authenticated with
 * the *backoffice* bearer token (never the Checkout token that created
 * the PA -- see docs/card-manage-payments, quoted in
 * src/lib/payments/providers/peach/config.ts). `id` is the path
 * parameter, not part of the body, so it isn't in this request shape --
 * the caller supplies it directly to the HTTP call.
 */
export function buildCardCaptureOrReversalRequest(paymentType: 'CP' | 'RV'): PeachCardCaptureOrReversalRequest {
  return { paymentType }
}

export interface PeachPayoutEntry {
  payoutId: string
  bankName: string
  accountNumber: string
  branchCode: string
  amount: number
  currency: string
  accountHolder: string
  reference: string
}

export interface PeachPayoutRequest {
  payouts: PeachPayoutEntry[]
}

/**
 * POST /merchants/{merchantId}/payouts -- amount is an INTEGER NUMBER OF
 * CENTS (`1000-500000000`, per docs/reference/createpayoutrequest), unlike
 * every other Peach amount field in this file, which is a decimal-string
 * rand amount. Converting Unity's rand `number` correctly here is the one
 * place a unit-mismatch bug would be easy to introduce -- covered
 * explicitly by src/lib/payments/providers/peach/__tests__/request-builders.test.ts.
 */
export function buildPayoutRequest(params: {
  payoutId: string
  bankName: string
  accountNumber: string
  branchCode: string
  amountRand: number
  currency: string
  accountHolder: string
  reference: string
}): PeachPayoutRequest {
  const amountCents = Math.round(params.amountRand * 100)
  return {
    payouts: [
      {
        payoutId: params.payoutId,
        bankName: params.bankName,
        accountNumber: params.accountNumber,
        branchCode: params.branchCode,
        amount: amountCents,
        currency: params.currency,
        accountHolder: params.accountHolder,
        reference: params.reference,
      },
    ],
  }
}

export function payoutsBearerHeader(config: PeachPayoutsConfig): { Authorization: string } {
  return { Authorization: `Bearer ${config.bearerToken}` }
}
