import type { MockScenario } from '@/lib/payments/provider'

/**
 * The ONLY file in the checkout domain allowed to reference MockScenario
 * or know that a provider called "mock" exists. Every other checkout file
 * (route, eligibility, readiness, UI) speaks this normalized vocabulary
 * instead -- so swapping the active provider later never requires
 * touching anything outside this one adapter plus the registry itself.
 * See docs/MOCK_CHECKOUT.md "Mock-to-Peach replacement steps".
 */
export const CHECKOUT_TEST_SCENARIOS = [
  'success',
  'rental_declined',
  'deposit_declined',
  'rental_retryable_failure',
  'deposit_retryable_failure',
  'timeout',
  'zero_deposit_success',
] as const

export type CheckoutTestScenario = (typeof CHECKOUT_TEST_SCENARIOS)[number]

export const CHECKOUT_TEST_SCENARIO_LABELS: Record<CheckoutTestScenario, string> = {
  success: 'Successful payment and deposit authorization',
  rental_declined: 'Rental payment declined',
  deposit_declined: 'Deposit authorization declined',
  rental_retryable_failure: 'Temporary rental-payment failure (retryable)',
  deposit_retryable_failure: 'Temporary deposit failure (retryable)',
  timeout: 'Provider timeout / uncertain response (retryable)',
  zero_deposit_success: 'Successful payment, no deposit required',
}

export function isCheckoutTestScenario(value: unknown): value is CheckoutTestScenario {
  return typeof value === 'string' && (CHECKOUT_TEST_SCENARIOS as readonly string[]).includes(value)
}

/**
 * Maps a normalized checkout scenario to the raw MockScenario value(s) the
 * orchestrator's testRentalScenario/testDepositScenario fields expect.
 * The same scenario value is deliberately used for both the rental and
 * deposit fields on the retryable/timeout scenarios -- the orchestrator
 * only ever calls the provider for whichever step hasn't already reached
 * its target status (see ensureRentalCharged/ensureDepositAuthorised in
 * authorize-booking-financials.ts), so passing the same value to both
 * naturally "does the right thing" on a fresh checkout (rental step) and
 * on a retry that resumes at the deposit step, without this adapter
 * needing to know which step is next.
 *
 * "zero_deposit_success" is not a distinct provider behaviour -- it is a
 * booking-data precondition (deposit_amount_snapshot = 0), so it maps
 * identically to "success"; prepareBookingFinancials already skips
 * creating a deposit payment entirely when no deposit is required.
 */
export function mapCheckoutScenarioToProviderScenarios(scenario: CheckoutTestScenario | undefined): {
  rentalScenario: MockScenario | undefined
  depositScenario: MockScenario | undefined
} {
  switch (scenario) {
    case undefined:
      return { rentalScenario: undefined, depositScenario: undefined }
    case 'success':
    case 'zero_deposit_success':
      return { rentalScenario: 'success', depositScenario: 'success' }
    case 'rental_declined':
      return { rentalScenario: 'declined', depositScenario: 'success' }
    case 'deposit_declined':
      return { rentalScenario: 'success', depositScenario: 'declined' }
    case 'rental_retryable_failure':
      return { rentalScenario: 'retryable_failure', depositScenario: 'success' }
    case 'deposit_retryable_failure':
      return { rentalScenario: 'success', depositScenario: 'retryable_failure' }
    case 'timeout':
      return { rentalScenario: 'timeout', depositScenario: 'timeout' }
  }
}

/**
 * The double gate required by Step 5: scenario selection is permitted
 * only when the active provider is "mock" AND the environment is
 * explicitly test/development -- never in production, never with Peach
 * selected, regardless of what a request body claims.
 */
export function isMockScenarioSelectionAllowed(): boolean {
  const provider = process.env.PAYMENT_PROVIDER || 'mock'
  if (provider !== 'mock') return false

  const paymentMode = process.env.NEXT_PUBLIC_PAYMENT_MODE
  if (paymentMode) return paymentMode === 'test'

  // NEXT_PUBLIC_PAYMENT_MODE not set -- fall back to NODE_ENV so a real
  // production build (which always sets NODE_ENV=production) is closed by
  // default even if an operator forgets to set the payment-mode var.
  return process.env.NODE_ENV !== 'production'
}
