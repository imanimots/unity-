import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '../../..')
const path = join(root, 'supabase/migrations/20261102090000_relocate_btree_gist_to_extensions_schema.sql')
const sql = readFileSync(path, 'utf8')
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

describe('E14 btree_gist relocation', () => {
  it('moves btree_gist to extensions', () => {
    expect(code).toMatch(/alter\s+extension\s+btree_gist\s+set\s+schema\s+extensions\s*;/i)
  })
  it('contains exactly one ALTER EXTENSION statement', () => {
    expect(code.match(/alter\s+extension/gi) ?? []).toHaveLength(1)
  })
  it('does not drop any extension', () => {
    expect(code).not.toMatch(/drop\s+extension/i)
  })
  it('does not touch the booking exclusion constraint', () => {
    expect(code).not.toMatch(/bookings_no_overlap_when_blocking|drop\s+constraint|add\s+constraint/i)
  })
  it('does not rebuild indexes or tables', () => {
    expect(code).not.toMatch(/create\s+(unique\s+)?index|drop\s+index|alter\s+table|create\s+table|drop\s+table/i)
  })
  it('does not change grants, RLS, or functions', () => {
    expect(code).not.toMatch(/\bgrant\b|\brevoke\b|create\s+(or\s+replace\s+)?function|create\s+policy|alter\s+policy|drop\s+policy/i)
  })
})
