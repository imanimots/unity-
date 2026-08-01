import type { OrchestrationErrorCode } from '../../orchestrator/errors'

/**
 * Maps a Peach result code (format `XXX.XXX.XXX`, docs/dashboard-response-codes)
 * to Unity's normalized OrchestrationErrorCode. Pure and offline -- no
 * network call, testable with fixture codes straight from the docs.
 *
 * Peach's own code families (000.xxx success/pending/rejected,
 * 700.xxx referencing-transaction errors, 800.xxx external-system
 * rejections, 2xxx.xxx payouts) don't line up with Unity's small,
 * deliberately provider-agnostic code set -- this function is the one
 * place that translation happens, so no orchestrator code ever needs to
 * know a Peach-specific string.
 *
 * Coverage here reflects only the codes actually found in official docs
 * during Phase 2D discovery (see docs/PEACH_INTEGRATION.md "Error
 * mapping" for the full table and sources). An unrecognized code falls
 * through to `terminal_provider_error` -- the safe default for "something
 * failed and we don't have a specific, confirmed classification for it
 * yet", never silently treated as success or as automatically retryable.
 */
export function mapPeachResultCodeToOrchestrationError(resultCode: string): OrchestrationErrorCode {
  // Hard declines / card-status rejections -- never automatically retried.
  if (/^800\.100\.15[1-9]$/.test(resultCode)) return 'provider_declined' // invalid/expired card family
  if (/^800\.100\.16[0-9]$/.test(resultCode)) return 'provider_declined' // blocked/lost/stolen card family
  if (resultCode === '800.100.155' || resultCode === '800.100.203') return 'provider_declined' // insufficient funds
  if (resultCode === '800.100.153' || resultCode === '800.100.192') return 'provider_declined' // CVV rejection

  // 3-D Secure / authentication.
  if (resultCode === '000.400.104') return 'provider_configuration_error' // missing/malformed 3DS config -- Unity's setup, not the customer's
  if (resultCode === '000.400.106') return 'provider_declined' // invalid PARes -- the customer's authentication attempt failed

  // Referencing-transaction errors (capture/refund/reversal against an
  // invalid or already-finalized original transaction).
  if (resultCode === '700.300.100') return 'invalid_payment_transition' // "can not be refunded, captured or reversed"
  if (resultCode === '700.400.200') return 'invalid_payment_transition' // refund/capture amount exceeds original -- closest existing code; see docs/PEACH_INTEGRATION.md limitations for why this isn't a perfect semantic fit

  // Throttling.
  if (resultCode === '800.120.100') return 'provider_unavailable' // "too many requests" -- retryable after backoff

  // Pending/timeout family.
  if (resultCode === '000.200.000' || resultCode === '000.400.081') return 'provider_timeout'

  return 'terminal_provider_error'
}

/**
 * Peach's own documented "successful" families
 * (docs/dashboard-response-codes): 000.000.x, 000.3xx.x, 000.4xx.110/120,
 * 000.5xx.x, 000.6xx.x (all successful), plus 000.400.0xx and 000.400.100
 * (successful but flagged for review -- still a successful transaction).
 */
export function isPeachSuccessResultCode(resultCode: string): boolean {
  const segments = resultCode.split('.')
  if (segments.length !== 3 || segments[0] !== '000') return false
  const [, mid, tail] = segments

  if (mid === '000') return true
  if (mid === '400') return tail === '110' || tail === '120' || tail === '100' || /^0\d\d$/.test(tail)
  if (/^[356]\d\d$/.test(mid)) return true
  return false
}
