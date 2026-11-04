import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '../../..')
const path = join(root, 'supabase/migrations/20261102090100_relocate_vector_to_extensions_schema.sql')
const sourcePath = join(root, 'supabase/migrations/20260615000002_knowledge_base_rpc.sql')
const sql = readFileSync(path, 'utf8')
const source = readFileSync(sourcePath, 'utf8')
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const normalized = code.replace(/\s+/g, ' ')

describe('E14 vector relocation', () => {
  it('moves vector to extensions', () => {
    expect(code).toMatch(/alter\s+extension\s+vector\s+set\s+schema\s+extensions\s*;/i)
  })
  it('does not drop vector or rebuild knowledge_base', () => {
    expect(code).not.toMatch(/drop\s+extension|alter\s+table\s+public\.knowledge_base|drop\s+table|create\s+index|drop\s+index/i)
  })
  it('redefines exactly match_knowledge_base and no other function', () => {
    const defs = code.match(/create\s+or\s+replace\s+function/gi) ?? []
    expect(defs).toHaveLength(1)
    expect(normalized).toContain('create or replace function public.match_knowledge_base(')
  })
  it('uses extensions.vector(1536) in the parameter', () => {
    expect(normalized).toContain('query_embedding extensions.vector(1536)')
  })
  it('pins match_knowledge_base to an empty search_path', () => {
    expect(normalized).toContain("set search_path = ''")
  })
  it('qualifies all three cosine-distance operators', () => {
    expect(code.match(/operator\(extensions\.<=>\)/gi) ?? []).toHaveLength(3)
    expect(code).not.toMatch(/\bembedding\s*<=>\s*query_embedding\b/)
  })
  it('preserves the original threshold and count defaults', () => {
    expect(normalized).toContain('match_threshold float default 0.7')
    expect(normalized).toContain('match_count int default 3')
  })
  it('preserves return shape and stable SQL semantics', () => {
    expect(normalized).toContain('returns table ( id uuid, content text, title text, category text, similarity float )')
    expect(normalized).toContain('language sql stable')
  })
  it('preserves the knowledge_base query source and ordering', () => {
    expect(normalized).toContain('from public.knowledge_base')
    expect(normalized).toContain('order by embedding operator(extensions.<=>) query_embedding')
  })
  it('does not change grants or RLS', () => {
    expect(code).not.toMatch(/\bgrant\b|\brevoke\b|create\s+policy|alter\s+policy|drop\s+policy/i)
  })
})
