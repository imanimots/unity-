import { createHash } from 'crypto'

/**
 * Opaque (created_at, id) keyset-pagination cursor for message history.
 * Same shape/behavior as src/lib/admin/cursor.ts and
 * src/lib/search/cursor.ts (opaque base64url JSON, 2048-char cap,
 * context-hash binding) -- reused rather than reinvented, kept as its
 * own small domain module rather than importing @/lib/admin/cursor.ts
 * directly, matching this repo's own precedent of one cursor module per
 * domain (search has its own too, despite an identical base shape).
 *
 * created_at alone is not a safe keyset boundary: Postgres `now()` is
 * stable within a transaction, so two messages inserted together (or
 * merely close enough in wall-clock time) can legally share the exact
 * same created_at -- see the messages table's schema (no UNIQUE
 * constraint on created_at, no ordering-relevant trigger). A cursor
 * that only carries a timestamp then has no way to resume exactly where
 * the previous page left off when a same-timestamp group straddles the
 * page boundary -- messages/id is the deterministic tie-breaker.
 *
 * The "context" bound here is the specific thread (booking_id/order_id/
 * barter_agreement_id) the cursor was minted for, so a cursor minted on
 * one thread is rejected outright (400) if replayed against a
 * different thread -- even one the caller legitimately participates in
 * -- rather than silently producing that other thread's own (safe but
 * semantically unrelated) page.
 */
export interface MessagesCursor {
  ts: string
  id: string
  contextHash: string
}

/** Thrown for a malformed cursor or one minted for a different thread -- callers translate this to a 400, never a crash or a silently wrong page. */
export class InvalidMessagesCursorError extends Error {
  constructor() {
    super('Invalid or expired pagination cursor')
    this.name = 'InvalidMessagesCursorError'
  }
}

export function encodeMessagesCursor(cursor: MessagesCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeMessagesCursor(encoded: string): MessagesCursor | null {
  if (!encoded || encoded.length > 2048) return null
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ts !== 'string' || typeof parsed.id !== 'string' || typeof parsed.contextHash !== 'string') {
      return null
    }
    return parsed as MessagesCursor
  } catch {
    return null
  }
}

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

/** Binds a cursor to the exact thread it was minted for. */
export function computeMessagesCursorContext(threadColumn: string, threadId: string): string {
  return md5(`messages|${threadColumn}=${threadId}`)
}

/** Decodes and validates a cursor against the current thread in one step -- throws InvalidMessagesCursorError for a malformed cursor OR one minted for a different thread. */
export function decodeAndValidateMessagesCursor(encoded: string, threadColumn: string, threadId: string): MessagesCursor {
  const decoded = decodeMessagesCursor(encoded)
  if (!decoded) throw new InvalidMessagesCursorError()
  if (decoded.contextHash !== computeMessagesCursorContext(threadColumn, threadId)) throw new InvalidMessagesCursorError()
  return decoded
}
