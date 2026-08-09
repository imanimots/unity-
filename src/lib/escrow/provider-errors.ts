/**
 * Errors an EscrowProvider implementation may throw. Mirrors
 * src/lib/payments/provider-errors.ts exactly -- the escrow orchestrator
 * (src/lib/escrow/orchestrator/) catches these and normalizes them, never
 * letting a raw provider error escape to a caller.
 */
export class EscrowProviderTimeoutError extends Error {
  constructor(provider: string, operation: string) {
    super(`${provider} timed out during ${operation}`)
    this.name = 'EscrowProviderTimeoutError'
  }
}

export class EscrowRetryableProviderError extends Error {
  constructor(provider: string, operation: string, detail?: string) {
    super(`${provider} returned a retryable error during ${operation}${detail ? `: ${detail}` : ''}`)
    this.name = 'EscrowRetryableProviderError'
  }
}

export class EscrowTerminalProviderError extends Error {
  constructor(provider: string, operation: string, detail?: string) {
    super(`${provider} returned a terminal error during ${operation}${detail ? `: ${detail}` : ''}`)
    this.name = 'EscrowTerminalProviderError'
  }
}

/**
 * Thrown by getEscrowProvider() (src/lib/escrow/registry.ts) -- never by
 * a provider implementation itself -- when the resolved provider is
 * unsafe for the current runtime environment. Today this means exactly
 * one thing: MockEscrowProvider ('mock') can never be resolved while
 * NODE_ENV === 'production', regardless of ESCROW_ENABLED. This is a
 * configuration/authorization failure, not a provider-level outcome
 * (timeout/retryable/terminal), so it is deliberately a distinct class,
 * mirroring OrchestrationErrorCode's existing 'provider_configuration_error'
 * concept from src/lib/payments/orchestrator/errors.ts (added during
 * Phase 2D/Peach discovery for the same category of failure -- a
 * provider that can't even be used, not one that failed to process a
 * request).
 */
export class EscrowProviderConfigurationError extends Error {
  constructor(detail: string) {
    super(`Escrow provider configuration is unsafe for this environment: ${detail}`)
    this.name = 'EscrowProviderConfigurationError'
  }
}
