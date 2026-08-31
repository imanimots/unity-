import { describe, it, expect } from 'vitest'
import {
  encodeKeysetCursor,
  decodeKeysetCursor,
  computeCursorContextHash,
  isKeysetCursorValidForContext,
  decodeAndValidateCursor,
  InvalidCursorError,
  type KeysetCursor,
} from '../cursor'

describe('admin keyset cursor encode/decode (category: Pagination)', () => {
  const sample: KeysetCursor = {
    ts: '2026-08-14T12:00:00.000Z',
    id: '11111111-1111-1111-1111-111111111111',
    contextHash: 'abc123',
  }

  it('1. round-trips every field exactly', () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(sample))).toEqual(sample)
  })

  it('2. malformed base64/JSON decodes to null, never throws', () => {
    expect(() => decodeKeysetCursor('not-valid-base64-json!!!')).not.toThrow()
    expect(decodeKeysetCursor('not-valid-base64-json!!!')).toBeNull()
  })

  it('3. well-formed JSON missing required fields decodes to null', () => {
    const bogus = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url')
    expect(decodeKeysetCursor(bogus)).toBeNull()
  })

  it('4. oversized cursor string (>2048 chars) is rejected outright', () => {
    expect(decodeKeysetCursor('a'.repeat(3000))).toBeNull()
  })

  it('5. empty string decodes to null', () => {
    expect(decodeKeysetCursor('')).toBeNull()
  })
})

describe('admin cursor context hash + binding (category: Pagination)', () => {
  it('6. identical params produce identical hashes regardless of key order', () => {
    const a = computeCursorContextHash('admin_orders', { status: 'delivered', search: 'x' })
    const b = computeCursorContextHash('admin_orders', { search: 'x', status: 'delivered' })
    expect(a).toBe(b)
  })

  it('7. a different filter value produces a different hash', () => {
    const a = computeCursorContextHash('admin_orders', { status: 'delivered' })
    const b = computeCursorContextHash('admin_orders', { status: 'pending' })
    expect(a).not.toBe(b)
  })

  it('8. a different entity produces a different hash for otherwise-identical params', () => {
    const a = computeCursorContextHash('admin_orders', { status: 'all' })
    const b = computeCursorContextHash('admin_financial_operations', { status: 'all' })
    expect(a).not.toBe(b)
  })

  it('9. isKeysetCursorValidForContext accepts a cursor minted for the same context', () => {
    const params = { status: 'delivered' }
    const cursor: KeysetCursor = { ts: '2026-08-14T12:00:00.000Z', id: 'x', contextHash: computeCursorContextHash('admin_orders', params) }
    expect(isKeysetCursorValidForContext(cursor, 'admin_orders', params)).toBe(true)
  })

  it('10. isKeysetCursorValidForContext rejects a cursor minted under different filters -- prevents splicing pages across a filter change', () => {
    const cursor: KeysetCursor = { ts: '2026-08-14T12:00:00.000Z', id: 'x', contextHash: computeCursorContextHash('admin_orders', { status: 'delivered' }) }
    expect(isKeysetCursorValidForContext(cursor, 'admin_orders', { status: 'pending' })).toBe(false)
  })
})

describe('decodeAndValidateCursor (category: Pagination)', () => {
  it('11. returns the decoded cursor when valid for the given context', () => {
    const params = { status: 'all' }
    const encoded = encodeKeysetCursor({ ts: '2026-08-14T12:00:00.000Z', id: 'x', contextHash: computeCursorContextHash('admin_orders', params) })
    expect(decodeAndValidateCursor(encoded, 'admin_orders', params)).toEqual({ ts: '2026-08-14T12:00:00.000Z', id: 'x', contextHash: computeCursorContextHash('admin_orders', params) })
  })

  it('12. throws InvalidCursorError for a malformed cursor', () => {
    expect(() => decodeAndValidateCursor('garbage', 'admin_orders', { status: 'all' })).toThrow(InvalidCursorError)
  })

  it('13. throws InvalidCursorError when filters changed since the cursor was minted', () => {
    const encoded = encodeKeysetCursor({ ts: '2026-08-14T12:00:00.000Z', id: 'x', contextHash: computeCursorContextHash('admin_orders', { status: 'delivered' }) })
    expect(() => decodeAndValidateCursor(encoded, 'admin_orders', { status: 'pending' })).toThrow(InvalidCursorError)
  })
})
