/**
 * E32: error surface for the payout-destination-authority feature.
 * Mirrors the orchestrator's own OrchestrationError pattern (one typed
 * error with a stable code, never a raw provider/Postgres message
 * forwarded to a caller) rather than introducing a second convention.
 */
export type PayoutDestinationErrorCode =
  | 'invalid_input'
  | 'bank_not_found'
  | 'bank_payout_unsupported'
  | 'bank_banv_unsupported'
  | 'destination_not_found'
  | 'destination_not_current'
  | 'identity_not_approved'
  | 'concurrent_change'
  | 'provider_configuration_error'
  | 'provider_timeout'
  | 'retryable_provider_error'
  | 'terminal_provider_error'
  | 'internal_consistency_error'

export class PayoutDestinationError extends Error {
  readonly code: PayoutDestinationErrorCode

  constructor(code: PayoutDestinationErrorCode, message: string) {
    super(message)
    this.name = 'PayoutDestinationError'
    this.code = code
  }
}
