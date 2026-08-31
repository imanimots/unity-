import { createHash } from 'crypto'

/**
 * Generic (timestamp, id) keyset-pagination cursor shared by admin list
 * surfaces (Admin Orders, Financial Operations). Mirrors
 * src/lib/search/cursor.ts's exact shape/behavior (opaque base64url JSON,
 * 2048-char cap, context-hash binding) rather than inventing a second
 * cursor framework -- generalized to a bare (ts, id) pair since these
 * surfaces have no tier/score/price ranking signal to carry.
 */
export interface KeysetCursor {
  ts: string
  id: string
  /** Binds a cursor to the exact filter state it was issued under -- see computeCursorContextHash(). */
  contextHash: string
}

/** Thrown when a caller-supplied cursor is malformed or was minted under different filters -- callers translate this to a 400, never a crash. */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid or expired pagination cursor')
    this.name = 'InvalidCursorError'
  }
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeKeysetCursor(encoded: string): KeysetCursor | null {
  if (!encoded || encoded.length > 2048) return null
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ts !== 'string' || typeof parsed.id !== 'string' || typeof parsed.contextHash !== 'string') {
      return null
    }
    return parsed as KeysetCursor
  } catch {
    return null
  }
}

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

/** Same sorted-key-serialization convention as computeSearchContextHash() -- order-independent, entity-scoped. */
export function computeCursorContextHash(entity: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const sortedKeys = Object.keys(params).sort()
  const serialized = sortedKeys.map((k) => `${k}=${params[k] ?? ''}`).join('&')
  return md5(`${entity}|${serialized}`)
}

export function isKeysetCursorValidForContext(cursor: KeysetCursor, entity: string, params: Record<string, string | number | boolean | null | undefined>): boolean {
  return cursor.contextHash === computeCursorContextHash(entity, params)
}

/**
 * Decodes and validates a cursor against the current filter context in
 * one step -- throws InvalidCursorError (never returns a silently wrong
 * page) for a malformed cursor OR one minted under different filters, so
 * a filter change can never be spliced onto a stale cursor's page.
 */
export function decodeAndValidateCursor(encoded: string, entity: string, params: Record<string, string | number | boolean | null | undefined>): KeysetCursor {
  const decoded = decodeKeysetCursor(encoded)
  if (!decoded) throw new InvalidCursorError()
  if (!isKeysetCursorValidForContext(decoded, entity, params)) throw new InvalidCursorError()
  return decoded
}
