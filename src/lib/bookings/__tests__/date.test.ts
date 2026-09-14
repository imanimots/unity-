import { describe, it, expect } from 'vitest'
import { calendarDateToSastIso } from '../date'

describe('calendarDateToSastIso', () => {
  it('A. serializes a normal date to the same visible calendar date with a +02:00 offset', () => {
    const d = new Date(2026, 8, 15) // month is 0-indexed: September 15, 2026, local midnight
    expect(calendarDateToSastIso(d)).toBe('2026-09-15T00:00:00+02:00')
  })

  it('B. zero-pads single-digit month and day', () => {
    const d = new Date(2026, 0, 5) // January 5, 2026
    expect(calendarDateToSastIso(d)).toBe('2026-01-05T00:00:00+02:00')
  })

  it('C. handles a year boundary correctly (Dec 31 -> Jan 1)', () => {
    const dec31 = new Date(2026, 11, 31)
    const jan1 = new Date(2027, 0, 1)
    expect(calendarDateToSastIso(dec31)).toBe('2026-12-31T00:00:00+02:00')
    expect(calendarDateToSastIso(jan1)).toBe('2027-01-01T00:00:00+02:00')
  })

  it('D. a Date carrying a non-midnight time still uses its own local calendar fields consistently', () => {
    const d = new Date(2026, 8, 15, 14, 37, 22) // Sep 15, 2026, 14:37:22 local
    expect(calendarDateToSastIso(d)).toBe('2026-09-15T00:00:00+02:00')
  })

  it('E. output matches the ISO-with-offset form accepted by the booking request schema', () => {
    const d = new Date(2026, 8, 15)
    const iso = calendarDateToSastIso(d)
    // Mirrors src/lib/bookings/validation.ts's z.string().datetime({ offset: true })
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })

  it('F. output does not end in Z', () => {
    const d = new Date(2026, 8, 15)
    expect(calendarDateToSastIso(d)).not.toMatch(/Z$/)
  })

  it('G. the selected calendar date is preserved as the YYYY-MM-DD prefix', () => {
    const d = new Date(2026, 8, 15)
    expect(calendarDateToSastIso(d).slice(0, 10)).toBe('2026-09-15')
  })
})
