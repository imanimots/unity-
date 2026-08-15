import { createHash } from 'crypto'

/**
 * Query normalization contract for all three ranking RPCs — applied
 * client-side before the query ever reaches SQL, so `p_query` sent to
 * the database is always already trimmed/collapsed/bounded. The RPCs
 * themselves also `nullif(trim(...), '')` defensively, so a caller
 * that skips this (a future non-UI caller, a test) still gets correct
 * behavior — this function exists to give the UI/API layer one
 * canonical place to apply it, and to bound pathological input
 * (SQL-injection-shaped or oversized strings) before it reaches
 * `ilike`/`websearch_to_tsquery`/`similarity`, all of which are safe
 * against injection via parameterization but not against an
 * attacker-sized string doing needless work.
 */
const MAX_QUERY_LENGTH = 200

export function normalizeSearchQuery(raw: string | null | undefined): string | null {
  if (!raw) return null
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  return collapsed.slice(0, MAX_QUERY_LENGTH)
}

export type SearchSort = 'relevance' | 'newest' | 'price_asc' | 'price_desc' | 'budget_asc' | 'budget_desc'

/**
 * Default sort resolution (§2 of the Search Ranking authorization):
 * an explicit user-chosen sort always wins, regardless of query state.
 * Only when no sort is explicitly chosen does the default depend on
 * whether a query was typed -- Relevant when `q` is non-empty, Newest
 * when it's empty. Pulled out as a pure function (rather than left
 * inline in each data-layer function) specifically so this precedence
 * rule is unit-testable without a database.
 */
export function resolveDefaultSort<T extends string>(explicitSort: T | undefined | null, normalizedQuery: string | null): T | 'relevance' | 'newest' {
  if (explicitSort) return explicitSort
  return normalizedQuery ? 'relevance' : 'newest'
}

/** Decoded cursor shape shared by all three ranking RPCs — a superset; each RPC's caller reads only the fields it needs. */
export interface SearchCursor {
  tier: number | null
  score: number | null
  price: number | null
  createdAt: string
  id: string
  /** Binds a cursor to the exact search state it was issued under — see computeSearchContextHash(). */
  contextHash: string
}

/**
 * Opaque to the UI by design (§25/§11 of the authorization) — the UI
 * only ever passes this string back verbatim as `?cursor=`, never
 * inspects or constructs its fields. Base64 of a small JSON object;
 * not a security boundary (no sensitive data crosses it — every field
 * mirrors data already visible in the page's own result list), just
 * an implementation-hiding convention plus the context-hash below.
 */
export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeSearchCursor(encoded: string): SearchCursor | null {
  if (!encoded || encoded.length > 2048) return null
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      typeof parsed.contextHash !== 'string' ||
      (parsed.tier !== null && typeof parsed.tier !== 'number') ||
      (parsed.score !== null && typeof parsed.score !== 'number') ||
      (parsed.price !== null && typeof parsed.price !== 'number')
    ) {
      return null
    }
    return parsed as SearchCursor
  } catch {
    return null
  }
}

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

/**
 * Binds a cursor to the exact search state (entity, normalized query,
 * sort, and filters) it was issued under, so a cursor minted for one
 * search (e.g. `q=camera&sort=relevance`) can't be replayed against a
 * different one (e.g. after the user changes the query or sort) to
 * produce a nonsensical spliced result page. Mirrors the md5-based
 * request-hash convention already used for barter RPC idempotency —
 * see src/lib/barter/idempotency.ts.
 */
export function computeSearchContextHash(entity: string, params: Record<string, string | number | boolean | null | undefined>): string {
  const sortedKeys = Object.keys(params).sort()
  const serialized = sortedKeys.map((k) => `${k}=${params[k] ?? ''}`).join('&')
  return md5(`${entity}|${serialized}`)
}

export function isCursorValidForContext(cursor: SearchCursor, entity: string, params: Record<string, string | number | boolean | null | undefined>): boolean {
  return cursor.contextHash === computeSearchContextHash(entity, params)
}
