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
        return {
          eq(_col: string, id: string) {
            const existing = deliveries.get(id)
            if (existing) deliveries.set(id, { ...existing, ...patch })
            return Promise.resolve({ data: null, error: null })
          },
        }
      },
      select() {
        return {
          eq(_col: string, value: string) {
            return {
              async maybeSingle() {
                const row = deliveries.get(value)
                return { data: row ?? null, error: null }
              },
            }
          },
          order() {
            return {
              // retryAllFailedDeliveries doesn't need real ordering for tests
            }
          },
        }
      },
    }
  }

  return {
    admin: { auth, from } as unknown as SupabaseClient,
    getDelivery: (id: string) => deliveries.get(id),
    deliveryCount: () => deliveries.size,
  }
}
