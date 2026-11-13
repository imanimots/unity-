/**
 * E33: pure field builders/validators for Peach's real-time EFT payout
 * contract, matching the exact constraints confirmed live against
 * developer.peachpayments.com/reference/createpayoutrequest this
 * phase. Kept separate from the HTTP client so each can be unit-tested
 * without a network mock.
 */

export class InvalidPayoutFieldError extends Error {
  constructor(field: string, reason: string) {
    super(`invalid payout field "${field}": ${reason}`)
    this.name = 'InvalidPayoutFieldError'
  }
}

const MIN_MINOR_UNITS = 1
const MAX_MINOR_UNITS = 500_000_000

/**
 * Converts a ZAR decimal amount (as a string or number, exactly as
 * read back from a numeric(12,2) Postgres column) to an integer number
 * of cents -- string-based, never floating-point multiplication (phase
 * brief §20). Rejects negative/zero amounts, more than 2 fractional
 * digits, and anything outside Peach's documented 1-500,000,000 range.
 */
export function convertZarToMinorUnits(amount: string | number): number {
  const str = typeof amount === 'number' ? amount.toFixed(2) : amount.trim()
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(str)
  if (!match) {
    throw new InvalidPayoutFieldError('amount', `"${str}" is not a plain non-negative decimal with at most 2 fractional digits`)
  }
  const wholePart = match[1]
  const fractionPart = (match[2] ?? '').padEnd(2, '0')
  const minorUnits = Number(wholePart) * 100 + Number(fractionPart)
  if (!Number.isSafeInteger(minorUnits)) {
    throw new InvalidPayoutFieldError('amount', 'amount is too large to represent safely')
  }
  if (minorUnits < MIN_MINOR_UNITS) {
    throw new InvalidPayoutFieldError('amount', 'amount must be greater than zero')
  }
  if (minorUnits > MAX_MINOR_UNITS) {
    throw new InvalidPayoutFieldError('amount', `amount exceeds Peach's maximum of ${MAX_MINOR_UNITS} minor units`)
  }
  return minorUnits
}

const REFERENCE_PATTERN = /^(?! )[A-Za-z0-9 ]{1,20}(?<! )$/

/**
 * Deterministic, non-PII reference: "UNITY " + the first 8 hex
 * characters of the provider attempt's own id (never the recipient's
 * name/account number/email/phone/ID number -- phase brief §19).
 * Validated against the exact confirmed pattern before returning --
 * fails closed rather than ever submitting a reference Peach would
 * reject.
 */
export function buildPayoutReference(attemptId: string): string {
  const hex = attemptId.replace(/-/g, '').slice(0, 8).toUpperCase()
  const reference = `UNITY ${hex}`
  if (!REFERENCE_PATTERN.test(reference)) {
    throw new InvalidPayoutFieldError('reference', `built reference "${reference}" does not match Peach's required pattern`)
  }
  return reference
}

const ACCOUNT_HOLDER_PATTERN = /^[a-zA-Z0-9]([ .-](?![ .-])|[a-zA-Z0-9]){0,48}[a-zA-Z0-9]$/

/**
 * Builds and validates the accountHolder field from the destination
 * owner's APPROVED, structured legal name (identity_verifications.
 * legal_first_name/legal_surname) -- never from an editable
 * profiles.display_name/full_name field, which is not payment-
 * authoritative (phase brief §23). Fails closed if the resulting
 * string does not satisfy Peach's exact confirmed pattern, rather than
 * silently stripping/mangling characters into something that might
 * pass but no longer identify the right person.
 */
export function buildAccountHolder(legalFirstName: string, legalSurname: string): string {
  const candidate = `${legalFirstName.trim()} ${legalSurname.trim()}`.trim()
  if (candidate.length < 2 || candidate.length > 50) {
    throw new InvalidPayoutFieldError('accountHolder', `"${candidate}" must be 2-50 characters`)
  }
  if (!ACCOUNT_HOLDER_PATTERN.test(candidate)) {
    throw new InvalidPayoutFieldError('accountHolder', `"${candidate}" does not match Peach's required pattern (alphanumeric, space/dot/hyphen, no consecutive separators)`)
  }
  return candidate
}
