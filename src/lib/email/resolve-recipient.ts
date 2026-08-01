import type { SupabaseClient } from '@supabase/supabase-js'

const RESOLVE_TIMEOUT_MS = 8_000

/**
 * profiles has no email column (confirmed during the Step 8 audit) --
 * email lives only on the Supabase-managed auth.users table, reachable
 * only via the service-role admin API, never a direct PostgREST select.
 * Returns null (never throws) if the user doesn't exist or has no email
 * on file -- the dispatch service treats that as "missing email handled
 * safely," not an error.
 *
 * Bounded with an explicit timeout -- supabase-js's admin API call has no
 * built-in timeout of its own, and a hung network call here must never
 * leave an entire route (e.g. checkout) stuck waiting indefinitely.
 * Live-caught during Step 8's own validation: an unbounded call here
 * produced a single request that took over 15 minutes end to end.
 */
export async function resolveUserEmail(admin: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), RESOLVE_TIMEOUT_MS))
    const lookup = admin.auth.admin
      .getUserById(userId)
      .then(({ data, error }) => (error || !data?.user?.email ? null : data.user.email))
      .catch(() => null)
    return await Promise.race([lookup, timeout])
  } catch {
    return null
  }
}
