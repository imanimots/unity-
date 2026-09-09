import { vi } from 'vitest'

/**
 * Minimal, generic chainable fake for the service-role Supabase client,
 * shared by the four evidence/attachment registration routes' Phase A
 * cleanup-sequencing tests. Not a general mocking framework -- covers
 * exactly the two chain shapes these routes use (a lookup ending in
 * .maybeSingle()/.single(), and an insert ending in
 * .select('*').single()), keyed by table name so each test configures
 * only the tables its scenario cares about. `.rpc()` is configured
 * separately by function name (used for the participant-check RPCs).
 *
 * This mocks the DATA LAYER only -- every real `if` check, and every
 * real `cleanup()` call, in the route under test still runs unmocked.
 *
 * Optional third param, `storageResponses`, keyed by bucket name --
 * added for POST /api/verification/documents (KYC Phase B1), which is
 * the first route in this family to call `.storage.from(bucket).info()`
 * directly (Storage object existence/metadata verification, not just
 * table queries). Purely additive: callers that don't pass it never
 * touch `.storage` at all, so every existing caller is unaffected.
 */
export function fakeServiceRoleClient(
  tableResponses: Record<string, { data: unknown; error?: unknown; count?: number }>,
  rpcResponses: Record<string, { data: unknown; error?: unknown }> = {},
  storageResponses: Record<string, { data: unknown; error?: unknown }> = {}
) {
  function makeChain(resolved: { data: unknown; error?: unknown; count?: number }) {
    const value = { data: resolved.data ?? null, error: resolved.error ?? null, count: resolved.count }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      insert: vi.fn(() => chain),
      order: () => chain,
      limit: () => chain,
      in: () => chain,
      maybeSingle: () => Promise.resolve(value),
      single: () => Promise.resolve(value),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(value).then(resolve, reject),
    }
    return chain
  }

  const from = vi.fn((table: string) => makeChain(tableResponses[table] ?? { data: null, error: null }))
  const rpc = vi.fn((fnName: string) => Promise.resolve(rpcResponses[fnName] ?? { data: null, error: null }))
  const storageInfo = vi.fn((bucket: string) => Promise.resolve(storageResponses[bucket] ?? { data: null, error: { status: 404, message: 'not found' } }))
  const storageRemove = vi.fn(() => Promise.resolve({ data: null, error: null }))
  const storage = { from: (bucket: string) => ({ info: () => storageInfo(bucket), remove: storageRemove }) }
  return { from, rpc, storage }
}
