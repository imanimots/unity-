import { describe, it, expect } from 'vitest'
import { toMinorUnits, InvalidAmountError } from '../amount'

describe('toMinorUnits (Peach Orchestration, P5C)', () => {
  it('converts a standard two-decimal amount', () => {
    expect(toMinorUnits('92.00')).toBe(9200)
  })

  it('converts a one-decimal amount', () => {
    expect(toMinorUnits('1.5')).toBe(150)
  })

  it('converts the smallest positive amount', () => {
    expect(toMinorUnits('0.01')).toBe(1)
  })

  it('converts a whole-rand amount with no decimal part', () => {
    expect(toMinorUnits('100')).toBe(10000)
  })

  it('converts a large amount without floating-point drift', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754 -- this exercises the same class of
    // value via the string-parsing path, which must not drift.
    expect(toMinorUnits('12345678.90')).toBe(1234567890)
  })

  it('rejects a negative amount', () => {
    expect(() => toMinorUnits('-1.00')).toThrow(InvalidAmountError)
  })

  it('rejects zero', () => {
    expect(() => toMinorUnits('0.00')).toThrow(InvalidAmountError)
  })

  it('rejects more than two decimal places', () => {
    expect(() => toMinorUnits('1.234')).toThrow(InvalidAmountError)
  })

  it('rejects a non-numeric string', () => {
    expect(() => toMinorUnits('abc')).toThrow(InvalidAmountError)
  })

  it('rejects an empty string', () => {
    expect(() => toMinorUnits('')).toThrow(InvalidAmountError)
  })

  it('rejects a value that would overflow Number.MAX_SAFE_INTEGER once converted', () => {
    expect(() => toMinorUnits('999999999999999.00')).toThrow(InvalidAmountError)
  })

  it('rejects scientific notation and other non-plain-decimal forms', () => {
    expect(() => toMinorUnits('9.2e1')).toThrow(InvalidAmountError)
  })
})
