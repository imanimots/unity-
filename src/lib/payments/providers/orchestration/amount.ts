/**
 * Decimal-string -> integer minor-unit conversion for Peach Orchestration
 * (P5C). Confirmed live: Orchestration represents amounts as an integer
 * number of minor units (92.00 ZAR -> 9200), unlike every classic Peach
 * product this repo's earlier stub scaffolding targeted, which used a
 * two-decimal-place string ("92.00").
 *
 * Operates on the string form of `payments.amount` (a numeric(12,2) DB
 * column, which the Supabase JS client already returns as a decimal
 * string, never a JS number) -- never on a floating-point
 * multiplication, which cannot represent every two-decimal rand amount
 * exactly (e.g. 0.1 + 0.2 !== 0.3 in IEEE 754).
 */

export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAmountError'
  }
}

const DECIMAL_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/

/**
 * Converts a positive decimal-string ZAR amount (e.g. "92.00", "1.5",
 * "0.01") to an integer number of minor units (cents). Rejects negative
 * values, malformed input, more than two decimal places, and results
 * that would exceed Number.MAX_SAFE_INTEGER.
 */
export function toMinorUnits(amount: string): number {
  if (typeof amount !== 'string' || !DECIMAL_AMOUNT_PATTERN.test(amount)) {
    throw new InvalidAmountError(`Amount "${amount}" is not a valid non-negative decimal with at most 2 places`)
  }

  const [randPart, centsPartRaw] = amount.split('.')
  const centsPart = (centsPartRaw ?? '').padEnd(2, '0')

  if (!/^\d+$/.test(randPart) || !/^\d{2}$/.test(centsPart)) {
    throw new InvalidAmountError(`Amount "${amount}" could not be split into whole-rand and cents parts`)
  }

  const randMinorUnits = BigInt(randPart) * BigInt(100)
  const centsMinorUnits = BigInt(centsPart)
  const totalMinorUnits = randMinorUnits + centsMinorUnits

  if (totalMinorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidAmountError(`Amount "${amount}" exceeds the maximum safely representable minor-unit value`)
  }

  const result = Number(totalMinorUnits)
  if (result <= 0) {
    throw new InvalidAmountError(`Amount "${amount}" must be a positive value for a payment operation`)
  }

  return result
}
