/**
 * Errors a PaymentProvider implementation may throw. Part of the
 * provider contract, not the orchestrator -- a real provider can
 * genuinely time out or return a retryable error independent of any
 * orchestration logic. The orchestrator (src/lib/payments/orchestrator/)
 * catches these and normalizes them into its own OrchestrationError
 * codes; it never lets a raw provider error escape to a caller.
 */
export class ProviderTimeoutError extends Error {
  constructor(provider: string, operation: string) {
    super(`${provider} timed out during ${operation}`)
    this.name = 'ProviderTimeoutError'
  }
}

export class RetryableProviderError extends Error {
  constructor(provider: string, operation: string, detail?: string) {
    super(`${provider} returned a retryable error during ${operation}${detail ? `: ${detail}` : ''}`)
    this.name = 'RetryableProviderError'
  }
}

export class TerminalProviderError extends Error {
  constructor(provider: string, operation: string, detail?: string) {
    super(`${provider} returned a terminal error during ${operation}${detail ? `: ${detail}` : ''}`)
    this.name = 'TerminalProviderError'
  }
}
