import { describe, it, expect } from 'vitest'
import {
  normalizeSearchQuery,
  encodeSearchCursor,
  decodeSearchCursor,
  computeSearchContextHash,
  isCursorValidForContext,
  resolveDefaultSort,
  type SearchCursor,
} from '../cursor'

describe('normalizeSearchQuery (category: Query Normalization)', () => {
  it('1. trims leading/trailing whitespace', () => {
    expect(normalizeSearchQuery('  camera  ')).toBe('camera')
  })

  it('2. collapses internal whitespace runs to a single space', () => {
    expect(normalizeSearchQuery('camping   gear\t\ttent')).toBe('camping gear tent')
  })

  it('3. empty string normalizes to null', () => {
    expect(normalizeSearchQuery('')).toBeNull()
  })

  it('4. whitespace-only string normalizes to null', () => {
    expect(normalizeSearchQuery('   \n\t  ')).toBeNull()
  })

  it('5. null/undefined normalize to null', () => {
    expect(normalizeSearchQuery(null)).toBeNull()
    expect(normalizeSearchQuery(undefined)).toBeNull()
  })

  it('6. oversized input is bounded to 200 characters, never passed through unbounded', () => {
    const huge = 'a'.repeat(5000)
    const result = normalizeSearchQuery(huge)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(200)
  })

  it('7. SQL-injection-shaped input is passed through as inert text, not stripped or rejected — safety comes from parameterized RPC args, not string sanitization', () => {
    const injected = "camera'; DROP TABLE listings; --"
    expect(normalizeSearchQuery(injected)).toBe(injected)
  })

  it('8. a single non-whitespace character survives', () => {
    expect(normalizeSearchQuery('a')).toBe('a')
  })
})

describe('search cursor encode/decode (category: Pagination)', () => {
  const sample: SearchCursor = {
    tier: 3,
    score: 0.5,
    price: 100,
    createdAt: '2026-08-14T12:00:00.000Z',
    id: '11111111-1111-1111-1111-111111111111',
    contextHash: 'abc123',
  }

  it('9. round-trips every field exactly', () => {
    const decoded = decodeSearchCursor(encodeSearchCursor(sample))
    expect(decoded).toEqual(sample)
  })

  it('10. round-trips null tier/score/price (empty-query/newest-browse cursors)', () => {
    const empty: SearchCursor = { tier: 0, score: 0, price: null, createdAt: '2026-08-14T12:00:00.000Z', id: sample.id, contextHash: 'x' }
    expect(decodeSearchCursor(encodeSearchCursor(empty))).toEqual(empty)
  })

  it('11. malformed base64/JSON decodes to null, never throws', () => {
    expect(() => decodeSearchCursor('not-valid-base64-json!!!')).not.toThrow()
    expect(decodeSearchCursor('not-valid-base64-json!!!')).toBeNull()
  })

  it('12. well-formed JSON missing required fields decodes to null', () => {
    const bogus = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url')
    expect(decodeSearchCursor(bogus)).toBeNull()
  })

  it('13. oversized cursor string (>2048 chars) is rejected outright', () => {
    expect(decodeSearchCursor('a'.repeat(3000))).toBeNull()
  })

  it('14. empty string decodes to null', () => {
    expect(decodeSearchCursor('')).toBeNull()
  })
})

describe('search context hash + cursor-context binding (category: Pagination)', () => {
  it('15. identical params produce identical hashes regardless of key order', () => {
    const a = computeSearchContextHash('listings', { query: 'camera', sort: 'relevance', category: null })
    const b = computeSearchContextHash('listings', { sort: 'relevance', category: null, query: 'camera' })
    expect(a).toBe(b)
  })

  it('16. a different query produces a different hash', () => {
    const a = computeSearchContextHash('listings', { query: 'camera', sort: 'relevance' })
    const b = computeSearchContextHash('listings', { query: 'bicycle', sort: 'relevance' })
    expect(a).not.toBe(b)
  })

  it('17. a different sort produces a different hash', () => {
    const a = computeSearchContextHash('listings', { query: 'camera', sort: 'relevance' })
    const b = computeSearchContextHash('listings', { query: 'camera', sort: 'newest' })
    expect(a).not.toBe(b)
  })

  it('18. a different entity produces a different hash for otherwise-identical params', () => {
    const a = computeSearchContextHash('listings', { query: 'camera' })
    const b = computeSearchContextHash('marketplace_requests', { query: 'camera' })
    expect(a).not.toBe(b)
  })

  it('19. isCursorValidForContext accepts a cursor minted for the same context', () => {
    const params = { query: 'camera', sort: 'relevance' }
    const cursor: SearchCursor = { tier: 3, score: 0.5, price: null, createdAt: '2026-08-14T12:00:00.000Z', id: 'x', contextHash: computeSearchContextHash('listings', params) }
    expect(isCursorValidForContext(cursor, 'listings', params)).toBe(true)
  })

  it('20. isCursorValidForContext rejects a cursor minted under a changed query — prevents splicing pages from two different searches', () => {
    const mintedUnder = { query: 'camera', sort: 'relevance' }
    const cursor: SearchCursor = { tier: 3, score: 0.5, price: null, createdAt: '2026-08-14T12:00:00.000Z', id: 'x', contextHash: computeSearchContextHash('listings', mintedUnder) }
    const changedTo = { query: 'bicycle', sort: 'relevance' }
    expect(isCursorValidForContext(cursor, 'listings', changedTo)).toBe(false)
  })

  it('21. isCursorValidForContext rejects a cursor minted under a changed sort', () => {
    const mintedUnder = { query: 'camera', sort: 'relevance' }
    const cursor: SearchCursor = { tier: 3, score: 0.5, price: null, createdAt: '2026-08-14T12:00:00.000Z', id: 'x', contextHash: computeSearchContextHash('listings', mintedUnder) }
    expect(isCursorValidForContext(cursor, 'listings', { query: 'camera', sort: 'newest' })).toBe(false)
  })
})

describe('resolveDefaultSort — explicit sort always wins (category: Sort Precedence)', () => {
  it('22. an explicit sort wins even when a query is present', () => {
    expect(resolveDefaultSort('price_asc', 'camera')).toBe('price_asc')
  })

  it('23. an explicit sort wins even when no query is present', () => {
    expect(resolveDefaultSort('price_desc', null)).toBe('price_desc')
  })

  it('24. no explicit sort + a query present defaults to relevance', () => {
    expect(resolveDefaultSort(undefined, 'camera')).toBe('relevance')
  })

  it('25. no explicit sort + no query defaults to newest', () => {
    expect(resolveDefaultSort(undefined, null)).toBe('newest')
  })

  it('26. null explicit sort is treated the same as undefined', () => {
    expect(resolveDefaultSort(null, 'camera')).toBe('relevance')
    expect(resolveDefaultSort(null, null)).toBe('newest')
  })

  it('27. explicit "newest" wins over a present query (does not get overridden to relevance)', () => {
    expect(resolveDefaultSort('newest', 'camera')).toBe('newest')
  })
})
