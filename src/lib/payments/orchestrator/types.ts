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
  status: 'completed' | 'failed_retryable' | 'failed_terminal'
  rentalPaymentId: string
  rentalStatus: string
  depositPaymentId: string | null
  depositStatus: string | null
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
