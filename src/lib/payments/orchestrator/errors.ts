/**
 * Normalized orchestration errors. Every orchestrator workflow throws one
 * of these -- never a raw Postgres error, never a raw provider error
 * (ProviderTimeoutError etc. from src/lib/payments/provider-errors.ts are
 * caught inside the orchestrator and translated to one of these codes).
 * A caller (an API route, a future admin action) maps `code` to an HTTP
 * status the same way src/lib/payments/rpc-errors.ts already does for
 * raw RPC messages -- this is the orchestrator-layer equivalent.
 */
export type OrchestrationErrorCode =
  | 'invalid_booking_state'
  | 'missing_payment'
  | 'duplicate_workflow_conflict'
  | 'provider_declined'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'retryable_provider_error'
  | 'terminal_provider_error'
  | 'invalid_payment_transition'
  | 'insufficient_deposit_authorization'
  | 'payout_unavailable'
  | 'internal_consistency_error'
  // Added during Phase 2D (Peach discovery): a real provider can fail before
  // ever reaching the payment network -- missing/malformed credentials, or a
  // webhook whose signature doesn't verify. Neither is a payment outcome
  // (declined/timeout/etc.), so neither belongs under those codes. See
  // docs/PEACH_INTEGRATION.md "Error mapping".
  | 'provider_configuration_error'
  | 'invalid_webhook_signature'

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode

  constructor(code: OrchestrationErrorCode, message: string) {
    super(message)
    this.name = 'OrchestrationError'
    this.code = code
  }
}

/** Whether retrying the same workflow (same idempotency key) might succeed. */
export function isRetryableOrchestrationError(code: OrchestrationErrorCode): boolean {
  return code === 'provider_unavailable' || code === 'provider_timeout' || code === 'retryable_provider_error'
}
