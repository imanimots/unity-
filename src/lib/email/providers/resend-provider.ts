import type { EmailProvider, SendEmailInput, SendEmailResult, HealthCheckResult } from '../provider'
import { EmailConfigurationError, InvalidRecipientError, EmailTimeoutError, RetryableEmailError, RateLimitedEmailError, TerminalEmailError } from '../errors'

const RESEND_API_URL = 'https://api.resend.com/emails'
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Server-only -- reads RESEND_API_KEY from process.env, never accepts a
 * key as a constructor argument from calling code (so a browser bundle
 * could never carry one even by mistake). No credentials are configured
 * in this environment as of Step 8 (confirmed during the audit) -- this
 * class is implemented against Resend's documented REST contract but is
 * never exercised against the live API this pass; EMAIL_PROVIDER stays
 * "console" in every environment this repository currently runs in. See
 * docs/TRANSACTIONAL_EMAILS.md "Known limitations".
 *
 * Idempotency-Key is sent as a header when the caller supplies one --
 * Resend documents support for it, but since no live call has been made
 * against a real account in this environment, its exact dedup-window
 * behaviour is unconfirmed and should be re-verified against Resend's own
 * docs before this provider is switched on for real traffic.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend'

  private apiKey(): string {
    const key = process.env.RESEND_API_KEY
    if (!key) {
      throw new EmailConfigurationError(this.name, 'RESEND_API_KEY is not set')
    }
    return key
  }

  async sendTransactionalEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const apiKey = this.apiKey()

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch(RESEND_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: input.from,
          to: [input.to],
          reply_to: input.replyTo,
          subject: input.subject,
          html: input.html,
          text: input.text,
        }),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new EmailTimeoutError(this.name)
      }
      throw new RetryableEmailError(this.name, err instanceof Error ? err.message : 'network error')
    } finally {
      clearTimeout(timeout)
    }

    if (res.status === 429) {
      throw new RateLimitedEmailError(this.name)
    }
    if (res.status === 401 || res.status === 403) {
      throw new EmailConfigurationError(this.name, `authentication failed (${res.status})`)
    }
    if (res.status === 422 || res.status === 400) {
      // Resend returns 4xx for malformed/rejected recipient addresses among other validation issues.
      throw new InvalidRecipientError(this.name, `provider rejected the request (${res.status})`)
    }
    if (res.status >= 500) {
      throw new RetryableEmailError(this.name, `provider returned ${res.status}`)
    }
    if (!res.ok) {
      throw new TerminalEmailError(this.name, `unexpected status ${res.status}`)
    }

    const body = (await res.json().catch(() => null)) as { id?: string } | null
    return { status: 'sent', providerMessageId: body?.id ?? null }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!process.env.RESEND_API_KEY) {
      return { healthy: false, provider: this.name, message: 'RESEND_API_KEY is not set' }
    }
    return { healthy: true, provider: this.name }
  }
}
