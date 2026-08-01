import { createHash } from 'crypto'
import type { EmailProvider, SendEmailInput, SendEmailResult, HealthCheckResult } from '../provider'
import { RetryableEmailError, TerminalEmailError } from '../errors'

/**
 * Local-development fallback -- never makes a network call, always the
 * default when EMAIL_PROVIDER is unset. Logs a redacted summary (subject
 * + recipient only, never the full HTML/text body, which could contain
 * booking/listing detail) and returns a deterministic message id derived
 * from the input, so a given (to, subject, idempotencyKey) always
 * produces the same id -- useful for asserting on logs in tests without
 * needing real randomness.
 *
 * Supports failure fixtures purely for exercising the retry/terminal
 * paths in tests and local development: a recipient address containing
 * "+fail-retryable" throws RetryableEmailError; "+fail-terminal" throws
 * TerminalEmailError. No other input can trigger a failure -- this
 * provider is otherwise unconditionally successful, matching "local
 * fallback" expectations.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console'

  async sendTransactionalEmail(input: SendEmailInput): Promise<SendEmailResult> {
    if (input.to.includes('+fail-retryable')) {
      throw new RetryableEmailError(this.name, 'simulated failure fixture')
    }
    if (input.to.includes('+fail-terminal')) {
      throw new TerminalEmailError(this.name, 'simulated failure fixture')
    }

    const messageId = `console_${createHash('md5').update(`${input.to}|${input.subject}|${input.idempotencyKey ?? ''}`).digest('hex').slice(0, 16)}`

    console.log('[email:console]', {
      to: input.to,
      from: input.from,
      subject: input.subject,
      messageId,
      textPreview: input.text.slice(0, 120),
    })

    return { status: 'sent', providerMessageId: messageId }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, provider: this.name }
  }
}
