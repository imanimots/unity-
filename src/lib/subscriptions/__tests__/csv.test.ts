import { describe, it, expect } from 'vitest'
import { csvSafeCell, toCsvRow, buildListingsCsv, parseCsv, LISTING_CSV_COLUMNS } from '../csv'

describe('csvSafeCell (category: formula-injection safety, Section 7)', () => {
  it('1. prefixes a cell starting with = to prevent formula execution', () => {
    expect(csvSafeCell('=cmd|/c calc')).toBe("'=cmd|/c calc")
  })
  it('2. prefixes a cell starting with +', () => {
    expect(csvSafeCell('+1+1')).toBe("'+1+1")
  })
  it('3. prefixes a cell starting with -', () => {
    expect(csvSafeCell('-1+1')).toBe("'-1+1")
  })
  it('4. prefixes a cell starting with @', () => {
    expect(csvSafeCell('@SUM(A1)')).toBe("'@SUM(A1)")
  })
  it('5. leaves an ordinary string untouched', () => {
    expect(csvSafeCell('Camping tent')).toBe('Camping tent')
  })
  it('6. quotes a cell containing a comma', () => {
    expect(csvSafeCell('Cape Town, Western Cape')).toBe('"Cape Town, Western Cape"')
  })
  it('7. escapes embedded quotes', () => {
    expect(csvSafeCell('He said "hi"')).toBe('"He said ""hi"""')
  })
  it('8. handles null/undefined as empty string', () => {
    expect(csvSafeCell(null)).toBe('')
    expect(csvSafeCell(undefined)).toBe('')
  })
  it('9. formula-prefixed AND comma-containing value is both escaped and quoted', () => {
    expect(csvSafeCell('=A1, B1')).toBe('"\'=A1, B1"')
  })
})

describe('buildListingsCsv (category: export)', () => {
  it('10. header row matches the stable documented column list', () => {
    const csv = buildListingsCsv([])
    expect(csv.split('\r\n')[0]).toBe(LISTING_CSV_COLUMNS.join(','))
  })
  it('11. a row with a dangerous title is neutralized in the output', () => {
    const csv = buildListingsCsv([{ id: '1', title: '=HYPERLINK("evil.com")', description: '', category: 'tech', condition: 'good', listing_type: 'rental', daily_rate: 100, weekly_rate: null, monthly_rate: null, sale_price: null, province: '', city: '', status: 'active' }])
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).not.toMatch(/,=HYPERLINK/)
  })
})

describe('parseCsv (category: import parsing)', () => {
  it('12. parses a simple 2-row CSV', () => {
    const rows = parseCsv('a,b,c\n1,2,3')
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })
  it('13. handles quoted fields containing commas', () => {
    const rows = parseCsv('title,city\n"Camping tent","Cape Town, Western Cape"')
    expect(rows[1]).toEqual(['Camping tent', 'Cape Town, Western Cape'])
  })
  it('14. handles escaped quotes inside a quoted field', () => {
    const rows = parseCsv('title\n"He said ""hi"""')
    expect(rows[1]).toEqual(['He said "hi"'])
  })
  it('15. round-trips a value written by csvSafeCell', () => {
    const original = 'Cape Town, "Best" City'
    const csv = toCsvRow([original])
    const parsed = parseCsv(csv)
    expect(parsed[0][0]).toBe(original)
  })
})
