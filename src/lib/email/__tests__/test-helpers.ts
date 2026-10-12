import { vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A minimal, stateful fake of the Supabase client surface
 * src/lib/email/service.ts actually uses -- insert-with-unique-conflict,
 * update-by-id, select-by-id. Not a general-purpose Supabase mock; just
 * enough to exercise the dispatch service's own logic (idempotency,
 * status transitions) without a live database, matching this codebase's
 * existing convention of unit-testing pure/deterministic logic and
 * validating DB-dependent behaviour via live validation instead (see
 * docs/PAYMENT_READINESS.md's own note on this same convention).
 *
 * P5D-ROUTE-HARDEN-I extended this fake to support multiple chained
 * .eq() filters plus an optional trailing .select().maybeSingle() after
 * .update(), so a test can simulate retryDelivery()'s atomic
 * compare-and-swap claim: `update({attempts: n+1}).eq('id', id)
 * .eq('status', 'failed_retryable').eq('attempts', n).select(...)
 * .maybeSingle()`. The match (ALL filters against the row's CURRENT
 * state) and the patch write happen synchronously within one call, with
 * no intermediate await -- so two "concurrent" claims raced via
 * Promise.all are still serialized by the JS event loop exactly the way
 * two concurrent Postgres UPDATEs are serialized by row locking: only
 * the first to actually run its match+write wins, and the second's
 * match fails because by the time it runs the row's `attempts` has
 * already moved. This is what lets a concurrency test against this fake
 * genuinely exercise the claim logic rather than merely assert on
 * sequential behaviour -- see the limitation note repeated in
 * service.test.ts's own concurrency test for what this does and does
 * not prove.
 */
export function createFakeEmailAdmin(opts: { email?: string | null } = {}) {
  const deliveries = new Map<string, Record<string, unknown>>()
  const byIdempotencyKey = new Set<string>()
  let idCounter = 0

  const auth = {
    admin: {
      getUserById: vi.fn(async () => {
        if (opts.email === null) return { data: { user: null }, error: null }
        return { data: { user: { email: opts.email ?? 'user@example.com' } }, error: null }
      }),
    },
  }

  type Filter = [string, unknown]

  function findMatch(filters: Filter[]): [string, Record<string, unknown>] | undefined {
    for (const [id, row] of deliveries) {
      if (filters.every(([col, value]) => row[col] === value)) return [id, row]
    }
    return undefined
  }

  function findAllMatches(filters: Filter[]): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = []
    for (const [, row] of deliveries) {
      if (filters.every(([col, value]) => row[col] === value)) rows.push(row)
    }
    return rows
  }

  function from(table: string) {
    if (table !== 'email_deliveries') {
      throw new Error(`fake admin does not support table "${table}"`)
    }
    return {
      insert(row: Record<string, unknown>) {
        return {
          select() {
            return {
              async maybeSingle() {
                const key = row.idempotency_key as string
                if (byIdempotencyKey.has(key)) {
                  return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
                }
                const id = `delivery-${++idCounter}`
                deliveries.set(id, { id, attempts: 0, ...row })
                byIdempotencyKey.add(key)
                return { data: { id }, error: null }
              },
            }
          },
        }
      },
      update(patch: Record<string, unknown>) {
        const filters: Filter[] = []
        const builder = {
          eq(col: string, value: unknown) {
            filters.push([col, value])
            return builder
          },
          select() {
            return {
              async maybeSingle() {
                // Atomic claim semantics: the match is evaluated against
                // CURRENT row state (not any value read earlier by the
                // caller), and applying the patch happens in the same
                // synchronous step as the match -- no await in between --
                // so a racing second caller whose filters no longer match
                // (because this call already moved the row) correctly
                // gets zero rows back, never a stale success.
                const match = findMatch(filters)
                if (!match) return { data: null, error: null }
                const [id, existing] = match
                const updated = { ...existing, ...patch }
                deliveries.set(id, updated)
                return { data: updated, error: null }
              },
            }
          },
          then(onResolve: (value: { data: null; error: null }) => unknown, onReject?: (reason: unknown) => unknown) {
            // No trailing .select() -- same unconditional-if-matched
            // semantics as before, just generalized to N filters.
            const match = findMatch(filters)
            if (match) {
              const [id, existing] = match
              deliveries.set(id, { ...existing, ...patch })
            }
            return Promise.resolve({ data: null, error: null }).then(onResolve, onReject)
          },
        }
        return builder
      },
      select() {
        const filters: Filter[] = []
        const builder = {
          eq(col: string, value: unknown) {
            filters.push([col, value])
            return builder
          },
          async maybeSingle() {
            const match = findMatch(filters)
            return { data: match ? match[1] : null, error: null }
          },
          order() {
            // retryAllFailedDeliveries isn't exercised through this fake
            // by any current test; kept awaitable (rather than the
            // previous non-thenable `{}` stub) so it fails loudly instead
            // of silently resolving to `undefined` data if that changes.
            return {
              then(onResolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown, onReject?: (reason: unknown) => unknown) {
                return Promise.resolve({ data: findAllMatches(filters), error: null }).then(onResolve, onReject)
              },
            }
          },
        }
        return builder
      },
    }
  }

  return {
    admin: { auth, from } as unknown as SupabaseClient,
    getDelivery: (id: string) => deliveries.get(id),
    deliveryCount: () => deliveries.size,
  }
}
