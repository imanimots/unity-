import { describe, it, expect, vi } from 'vitest'
import { evaluateQueryResult, safeFetchText } from '../fail-closed.mjs'

describe('evaluateQueryResult — fail-closed (category: Regression Script Integrity)', () => {
  it('1. a Supabase error is a failure, even if data happens to be an empty array', () => {
    const result = evaluateQueryResult({ data: null, error: { code: '42703', message: 'column listings.is_test does not exist' } })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('42703')
  })

  it('2. a missing-column error specifically is never coerced into a passing empty result', () => {
    // This is the exact bug this module exists to prevent: the old script did
    // `const { data } = await query; check(label, (data ?? []).length === 0)`,
    // which reads as "zero rows" -- a false pass -- when the column is missing.
    const result = evaluateQueryResult({ data: null, error: { code: '42703', message: 'column does not exist' } }, { expectArray: true })
    expect(result.ok).toBe(false)
  })

  it('3. a null result where an array was expected is a failure, not an empty array', () => {
    const result = evaluateQueryResult({ data: null, error: null }, { expectArray: true })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('null')
  })

  it('4. a non-array result where an array was expected is a failure', () => {
    const result = evaluateQueryResult({ data: { unexpected: 'shape' }, error: null }, { expectArray: true })
    expect(result.ok).toBe(false)
  })

  it('5. a genuine empty array with no error is a real pass-through, not a failure', () => {
    const result = evaluateQueryResult({ data: [], error: null }, { expectArray: true })
    expect(result.ok).toBe(true)
    expect(result.data).toEqual([])
  })

  it('6. undefined data with no error is a failure when a single row was expected', () => {
    const result = evaluateQueryResult({ data: undefined, error: null }, { expectArray: false })
    expect(result.ok).toBe(false)
  })

  it('7. a genuine null row (maybeSingle, no match) with no error is a legitimate pass-through', () => {
    const result = evaluateQueryResult({ data: null, error: null }, { expectArray: false })
    expect(result.ok).toBe(true)
    expect(result.data).toBeNull()
  })
})

describe('safeFetchText — fail-closed HTTP (category: Regression Script Integrity)', () => {
  it('8. a thrown network error becomes an explicit ok:false, never an uncaught exception', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    try {
      const result = await safeFetchText('http://localhost:1/never')
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('ECONNREFUSED')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('9. a successful response (even a 500) is ok:true — the caller decides pass/fail on content', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 500, headers: new Headers(), text: async () => 'Internal Server Error' })
    try {
      const result = await safeFetchText('http://localhost:1/error')
      expect(result.ok).toBe(true)
      expect(result.status).toBe(500)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
