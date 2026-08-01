/**
 * Errors an EmailProvider implementation may throw -- mirrors
 * src/lib/payments/provider-errors.ts exactly (same five-way
 * classification the brief asks for: configuration error, invalid
 * recipient, retryable provider failure, terminal provider rejection,
 * timeout, rate limit -- rate limit and timeout are both modeled as
 * retryable, matching how a real caller should treat them). The dispatch
 * service (service.ts) catches these and normalizes them into the
 * delivery row's status; a provider's raw error message never reaches a
 * user-facing response.
 */
export class EmailConfigurationError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} is not configured correctly: ${detail}`)
    this.name = 'EmailConfigurationError'
  }
}

export class InvalidRecipientError extends Error {
  constructor(provider: string, detail?: string) {
    super(`${provider} rejected the recipient address${detail ? `: ${detail}` : ''}`)
    this.name = 'InvalidRecipientError'
  }
}

export class EmailTimeoutError extends Error {
  constructor(provider: string) {
    super(`${provider} timed out sending the email`)
    this.name = 'EmailTimeoutError'
  }
}

export class RetryableEmailError extends Error {
  constructor(provider: string, detail?: string) {
    super(`${provider} returned a retryable error${detail ? `: ${detail}` : ''}`)
    this.name = 'RetryableEmailError'
  }
}

export class RateLimitedEmailError extends Error {
  constructor(provider: string) {
    super(`${provider} rate-limited this request`)
    this.name = 'RateLimitedEmailError'
  }
}

export class TerminalEmailError extends Error {
  constructor(provider: string, detail?: string) {
    super(`${provider} returned a terminal error${detail ? `: ${detail}` : ''}`)
    this.name = 'TerminalEmailError'
  }
}

/** configuration_error and invalid_recipient are never retried automatically -- they need a human/config fix, not a resend. timeout/retryable/rate_limit all resolve to failed_retryable. */
export function isRetryableEmailError(err: unknown): boolean {
  return err instanceof EmailTimeoutError || err instanceof RetryableEmailError || err instanceof RateLimitedEmailError
}
