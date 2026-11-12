import { describe, it, expect } from 'vitest'
import { convertZarToMinorUnits, buildPayoutReference, buildAccountHolder, InvalidPayoutFieldError } from '../payout-fields'

describe('convertZarToMinorUnits -- strict decimal to integer cents, no floating point', () => {
  it('1. converts a plain integer amount', () => {
    expect(convertZarToMinorUnits('100')).toBe(10000)
  })

  it('2. converts an exact 2-decimal amount', () => {
    expect(convertZarToMinorUnits('19.99')).toBe(1999)
  })

  it('3. pads a single-decimal amount', () => {
    expect(convertZarToMinorUnits('19.1')).toBe(1910)
  })

  it('4. accepts a JS number input via toFixed(2), avoiding the classic 19.1*100 float bug', () => {
    expect(convertZarToMinorUnits(19.1)).toBe(1910)
    expect(convertZarToMinorUnits(0.1)).toBe(10)
  })

  it('5. rejects zero', () => {
    expect(() => convertZarToMinorUnits('0')).toThrow(InvalidPayoutFieldError)
    expect(() => convertZarToMinorUnits('0.00')).toThrow(InvalidPayoutFieldError)
  })

  it('6. rejects a negative amount', () => {
    expect(() => convertZarToMinorUnits('-5')).toThrow(InvalidPayoutFieldError)
  })

  it('7. rejects more than 2 fractional digits', () => {
    expect(() => convertZarToMinorUnits('19.999')).toThrow(InvalidPayoutFieldError)
  })

  it('8. rejects non-numeric input', () => {
    expect(() => convertZarToMinorUnits('abc')).toThrow(InvalidPayoutFieldError)
    expect(() => convertZarToMinorUnits('19.99.99')).toThrow(InvalidPayoutFieldError)
  })

  it("9. rejects an amount exceeding Peach's documented maximum (500,000,000 minor units)", () => {
    expect(() => convertZarToMinorUnits('5000001.00')).toThrow(InvalidPayoutFieldError)
  })

  it('10. accepts exactly the documented maximum', () => {
    expect(convertZarToMinorUnits('5000000.00')).toBe(500_000_000)
  })

  it('11. accepts the minimum (1 minor unit)', () => {
    expect(convertZarToMinorUnits('0.01')).toBe(1)
  })
})

describe('buildPayoutReference -- deterministic, non-PII, matches the exact confirmed Peach pattern', () => {
  it('12. builds a reference from the attempt id, uppercased, with the UNITY prefix', () => {
    const reference = buildPayoutReference('3f2a9b1c-aaaa-bbbb-cccc-dddddddddddd')
    expect(reference).toBe('UNITY 3F2A9B1C')
  })

  it('13. the built reference always matches Peach\'s exact confirmed pattern (alnum+space, 1-20 chars, no leading/trailing space)', () => {
    const reference = buildPayoutReference('00000000-0000-0000-0000-000000000000')
    expect(reference).toMatch(/^(?! )[A-Za-z0-9 ]{1,20}(?<! )$/)
    expect(reference.length).toBeLessThanOrEqual(20)
  })

  it('14. strips hyphens from the uuid before slicing', () => {
    const reference = buildPayoutReference('abcdefgh-ijkl')
    expect(reference).toBe('UNITY ABCDEFGH')
  })

  it('15. never includes any PII -- no name, account number, email, phone, or ID number input is accepted at all (the function only ever takes an attempt id)', () => {
    const reference = buildPayoutReference('11112222-3333-4444-5555-666677778888')
    expect(reference).not.toMatch(/@/)
  })
})

describe('buildAccountHolder -- sourced from approved KYC identity only, validated against the exact confirmed Peach pattern', () => {
  it('16. builds "First Last" from legal first name and surname', () => {
    expect(buildAccountHolder('Jane', 'Smith')).toBe('Jane Smith')
  })

  it('17. trims extraneous whitespace', () => {
    expect(buildAccountHolder('  Jane  ', '  Smith  ')).toBe('Jane Smith')
  })

  it('18. rejects a name shorter than 2 characters', () => {
    expect(() => buildAccountHolder('', '')).toThrow(InvalidPayoutFieldError)
  })

  it('19. rejects a name longer than 50 characters', () => {
    expect(() => buildAccountHolder('A'.repeat(30), 'B'.repeat(30))).toThrow(InvalidPayoutFieldError)
  })

  it('20. rejects a name containing a character outside Peach\'s confirmed pattern (alphanumeric, space, dot, hyphen)', () => {
    expect(() => buildAccountHolder('Jane_', 'Smith')).toThrow(InvalidPayoutFieldError)
    expect(() => buildAccountHolder('Jané', 'Smith')).toThrow(InvalidPayoutFieldError)
  })

  it('21. accepts a hyphenated surname', () => {
    expect(buildAccountHolder('Jane', 'Smith-Jones')).toBe('Jane Smith-Jones')
  })

  it('22. fails closed rather than silently stripping/mangling an invalid character into something that might pass but no longer identify the right person', () => {
    expect(() => buildAccountHolder('Jane@', 'Smith')).toThrow(/does not match/)
  })
})
