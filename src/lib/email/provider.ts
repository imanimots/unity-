/**
 * The provider-neutral contract every email provider implements. Mirrors
 * the exact shape already proven for payments (src/lib/payments/provider.ts)
 * and identity/ownership verification -- a domain calling code never knows
 * whether Console or Resend (or a future provider) is behind this
 * interface. Deliberately minimal: raw send + health check only. Template
 * rendering, idempotency, delivery records, and recipient resolution all
 * live one layer up, in src/lib/email/service.ts -- never inside a
 * provider implementation.
 */
export interface SendEmailInput {
  to: string
  from: string
  replyTo?: string
  subject: string
  html: string
  text: string
  /** Passed through to providers that support provider-level dedup (Resend does); providers without support simply ignore it. */
  idempotencyKey?: string
}

export interface SendEmailResult {
  status: 'sent'
  providerMessageId: string | null
}

export interface HealthCheckResult {
  healthy: boolean
  provider: string
  message?: string
}

export interface EmailProvider {
  readonly name: string
  /** Throws an EmailProviderError (see errors.ts) on any failure -- never returns a "failed" result, since the failure classification (retryable vs terminal) is exactly what the thrown error type encodes. */
  sendTransactionalEmail(input: SendEmailInput): Promise<SendEmailResult>
  healthCheck(): Promise<HealthCheckResult>
}
