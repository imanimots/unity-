import type { SupabaseClient } from '@supabase/supabase-js'
import type { MockScenario } from '../provider'

/**
 * Every orchestrator function takes a service-role Supabase client -- the
 * same one every existing API route already constructs
 * (createClient(url, serviceKey) from '@supabase/supabase-js') -- never
 * the session-scoped client. This is what makes the orchestrator callable
 * only from trusted server code: it needs a credential the browser never
 * has access to.
 *
 * testRentalScenario / testDepositScenario exist only so a live test can
 * deliberately force a specific step of authorize-booking-financials to
 * fail in a chosen way (e.g. rental succeeds, deposit is declined) --
 * meaningful only when providerName is 'mock' and never set by any real
 * caller (the booking accept route never sets them). Kept as two
 * separate fields, not one, because Scenario B/C-style tests need to
 * control each provider call independently within a single workflow run.
 */
export interface OrchestratorContext {
  admin: SupabaseClient
  providerName?: string
  testRentalScenario?: MockScenario
  testDepositScenario?: MockScenario
}

export interface PrepareBookingFinancialsResult {
  rentalPaymentId: string
  depositPaymentId: string | null
}

export interface AuthorizeBookingFinancialsResult {
  workflowId: string
  /**
   * `'requires_action'` (P5C.1): the rental charge and/or deposit
   * authorization created a Hosted Checkout session the shopper must
   * still complete -- `payments.status` stays `pending` for whichever
   * leg(s) this applies to, and neither is a workflow failure. The
   * route layer surfaces `rentalRedirectUrl`/`depositRedirectUrl` to the
   * caller; P5D's webhook reconciliation is what eventually resolves
   * this to `'completed'` or a failure.
   */
  status: 'completed' | 'failed_retryable' | 'failed_terminal' | 'requires_action'
  rentalPaymentId: string
  rentalStatus: string
  depositPaymentId: string | null
  depositStatus: string | null
  rentalRedirectUrl?: string
  depositRedirectUrl?: string
}

export interface ReleaseDepositResult {
  paymentId: string
  status: 'released'
}

export interface CaptureDepositResult {
  paymentId: string
  status: 'captured' | 'partially_captured'
  capturedAmount: number
  releasedAmount: number
}

export interface CreateMerchantPayoutResult {
  payoutId: string
  amount: number
  status: 'pending'
}
