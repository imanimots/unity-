/**
 * Advertising billing provider abstraction -- deliberately its own
 * interface, never overloaded onto src/lib/payments/provider.ts's
 * PaymentProvider (booking-shaped payments and advertising spend are
 * structurally separate financial concerns per the binding Advertising
 * MVP prompt). The campaign-funding flow talks only to this interface.
 *
 * No implementation of this interface moves real money in this phase --
 * see MockAdvertisingBillingProvider (fully functional, deterministic,
 * in-memory). Selection mirrors src/lib/payments/registry.ts's exact
 * pattern (interface + registry + mock + provider-name-as-data).
 */

export type AdvertisingMockScenario = 'success' | 'declined' | 'timeout'

export interface AdvertisingChargeInput {
  advertiserId: string
  campaignId: string
  amountCents: number
  currency: string
  mockScenario?: AdvertisingMockScenario
}

export interface AdvertisingChargeResult {
  providerReference: string
  status: 'succeeded' | 'failed'
  failureReason?: string
}

export interface AdvertisingRefundInput {
  providerReference: string
  amountCents: number
  currency: string
}

export interface AdvertisingRefundResult {
  providerReference: string
  status: 'refunded' | 'failed'
  failureReason?: string
}

export interface AdvertisingBillingProvider {
  charge(input: AdvertisingChargeInput): Promise<AdvertisingChargeResult>
  refund(input: AdvertisingRefundInput): Promise<AdvertisingRefundResult>
}

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} is not implemented`)
    this.name = 'NotImplementedError'
  }
}
