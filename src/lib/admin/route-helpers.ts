import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import type { AuthedProfile } from '@/lib/supabase/require-admin'

/**
 * Shared boilerplate for every /api/admin/** mutation route: rate limit,
 * then the authoritative server-side admin check (requireAdmin() --
 * never a client-supplied role claim). Originally built for the Step 3
 * listing-moderation routes; moved here (from
 * src/lib/listings/admin-route-helpers.ts) when Step 4's identity
 * verification admin routes needed the exact same boilerplate --
 * genuinely domain-neutral, so it belongs outside src/lib/listings.
 */
export async function requireAdminForRoute(
  request: NextRequest,
  rateLimitKeyPrefix: string
): Promise<{ ok: true; requester: AuthedProfile } | { ok: false; response: NextResponse }> {
  const rate = checkRateLimit(`${rateLimitKeyPrefix}:${getClientKey(request)}`, 30, 60_000)
  if (!rate.allowed) {
    return { ok: false, response: NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 }) }
  }

  const requester = await requireAdmin()
  if (!requester) {
    return { ok: false, response: NextResponse.json({ error: 'You must be signed in as an administrator' }, { status: 401 }) }
  }

  return { ok: true, requester }
}

/** The service-role client every admin RPC requires -- never the session-scoped client, matching the rest of this codebase's service-role convention. */
export async function getAdminServiceClient(): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(url, serviceKey)
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value)
}
