import { describe, it, expect } from 'vitest'
import { toCsv } from '../csv'

describe('csv: safe serialization (category: CSV Exports)', () => {
  it('1. serializes a simple row set with a header', () => {
    const csv = toCsv(['id', 'name'], [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }])
    expect(csv).toBe('id,name\n1,Alice\n2,Bob')
  })

  it('2. escapes values containing commas', () => {
    const csv = toCsv(['name'], [{ name: 'Smith, John' }])
    expect(csv).toContain('"Smith, John"')
  })

  it('3. escapes values containing double quotes', () => {
    const csv = toCsv(['name'], [{ name: 'The "Best" Item' }])
    expect(csv).toContain('"The ""Best"" Item"')
  })

  it('4. renders null/undefined as an empty cell, not the literal string "null"', () => {
    const csv = toCsv(['note'], [{ note: null }])
    expect(csv).toBe('note\n')
    expect(csv).not.toContain('null')
  })

  it('5. only serializes the columns explicitly passed in, even if the row has more fields', () => {
    const csv = toCsv(['id'], [{ id: '1', secret: 'do-not-export' } as unknown as { id: string }])
    expect(csv).not.toContain('do-not-export')
  })

  it('6. prevents spreadsheet formula injection -- a leading = is neutralized with a leading quote (Step 11 Phase 7)', () => {
    const csv = toCsv(['note'], [{ note: '=1+1' }])
    expect(csv).toContain("'=1+1")
  })

  it('7. neutralizes the other formula-injection leading characters Excel/Sheets recognize: + - @', () => {
    expect(toCsv(['note'], [{ note: '+1+1' }])).toContain("'+1+1")
    expect(toCsv(['note'], [{ note: '-1+1' }])).toContain("'-1+1")
    expect(toCsv(['note'], [{ note: '@SUM(A1)' }])).toContain("'@SUM(A1)")
  })

  it('8. does not alter a value that merely contains one of those characters mid-string', () => {
    const csv = toCsv(['note'], [{ note: 'total = 5' }])
    expect(csv).toContain('total = 5')
    expect(csv).not.toContain("'total")
  })
})
