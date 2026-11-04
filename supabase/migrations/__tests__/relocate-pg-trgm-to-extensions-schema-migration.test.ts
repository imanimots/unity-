import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '../../..')
const path = join(root, 'supabase/migrations/20261102090200_relocate_pg_trgm_to_extensions_schema.sql')
const sourcePath = join(root, 'supabase/migrations/20260902000006_search_ranking_keyword_stuffing_fix.sql')
const sql = readFileSync(path, 'utf8')
const source = readFileSync(sourcePath, 'utf8')
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = code.replace(/\s+/g, ' ')

function extractFn(content: string, name: string) {
  const marker = 'create or replace function public.' + name + '('
  const i = content.toLowerCase().lastIndexOf(marker.toLowerCase())
  if (i < 0) throw new Error('missing ' + name)
  const j = content.indexOf('$$;', i)
  if (j < 0) throw new Error('unterminated ' + name)
  return content.slice(i, j + 3)
}

const names = ['search_listings', 'search_marketplace_requests', 'search_skill_task_posts'] as const

describe('E14 pg_trgm relocation', () => {
  it('moves pg_trgm to extensions', () => {
    expect(code).toMatch(/alter\s+extension\s+pg_trgm\s+set\s+schema\s+extensions\s*;/i)
  })
  it('does not drop pg_trgm or rebuild trigram indexes', () => {
    expect(code).not.toMatch(/drop\s+extension|create\s+(unique\s+)?index|drop\s+index/i)
  })
  it('redefines exactly the three current search RPCs', () => {
    expect(code.match(/create\s+or\s+replace\s+function/gi) ?? []).toHaveLength(3)
    for (const name of names) expect(normalized).toContain('create or replace function public.' + name + '(')
  })
  it('schema-qualifies all six similarity calls', () => {
    expect(code.match(/extensions\.similarity\s*\(/gi) ?? []).toHaveLength(6)
    const unqualified = code.replace(/extensions\.similarity\s*\(/gi, '')
    expect(unqualified).not.toMatch(/\bsimilarity\s*\(/i)
  })
  it('retains fixed public search_path on all three RPCs', () => {
    expect(code.match(/set\s+search_path\s*=\s*public/gi) ?? []).toHaveLength(3)
  })
  it('preserves SECURITY INVOKER on all three RPCs', () => {
    expect(code.match(/security\s+invoker/gi) ?? []).toHaveLength(3)
    expect(code).not.toMatch(/security\s+definer/i)
  })
  it('preserves each authoritative function body except similarity qualification', () => {
    for (const name of names) {
      const before = extractFn(source, name).replace(/\s+/g, ' ').trim()
      const after = extractFn(code, name).replace(/extensions\.similarity\s*\(/g, 'similarity(').replace(/\s+/g, ' ').trim()
      expect(after, name).toBe(before)
    }
  })
  it('does not redefine the tier2 coverage helper', () => {
    expect(code).not.toMatch(/create\s+or\s+replace\s+function\s+public\._search_tier2_coverage_score/i)
  })
  it('does not change grants or RLS', () => {
    expect(code).not.toMatch(/\bgrant\b|\brevoke\b|create\s+policy|alter\s+policy|drop\s+policy/i)
  })
  it('contains no destructive table, view, or constraint DDL', () => {
    expect(code).not.toMatch(/drop\s+table|alter\s+table|drop\s+view|create\s+view|drop\s+constraint|add\s+constraint/i)
  })
})
