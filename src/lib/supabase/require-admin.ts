import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { IS_MOCK_MODE, MOCK_CURRENT_PROFILE } from '@/lib/mock/data'
import type { Profile } from '@/types'

export interface AuthedProfile {
  userId: string
  profile: Profile
}

/**
 * Resolves the current request's authenticated user + profile from the
 * Supabase session cookie. Returns null if unauthenticated or unconfigured.
 * Server-only (route handlers, server components) — reads `next/headers`.
 */
export async function getRequestProfile(): Promise<AuthedProfile | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null

  const cookieStore = await cookies()
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Called from a server component — middleware handles refresh
        }
      },
    },
  })

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single()
  if (!profile) return null

  return { userId: user.id, profile: profile as Profile }
}

/**
 * Server-side admin gate. This is the authoritative check — the only one
 * that matters for authorization. Client-side checks (localStorage flags,
 * hiding UI) are cosmetic at best and must never be the sole gate.
 *
 * Mock mode (no Supabase configured) allows access unconditionally, matching
 * how the rest of the codebase treats mock mode as a local-only demo state
 * with no real data at stake. When Supabase IS configured (as it is in this
 * project's .env.local), this performs a real `profiles.role === 'admin'`
 * check.
 */
export async function requireAdmin(): Promise<AuthedProfile | null> {
  if (IS_MOCK_MODE) {
    return { userId: MOCK_CURRENT_PROFILE.id, profile: MOCK_CURRENT_PROFILE }
  }

  const result = await getRequestProfile()
  if (!result || result.profile.role !== 'admin') return null
  return result
}

/**
 * Server-side authentication gate for any signed-in user — the authoritative
 * check for `(dashboard)` routes (renter dashboard, merchant dashboard,
 * affiliate dashboard), mirroring `requireAdmin()`'s pattern. The
 * proxy/middleware layer also redirects unauthenticated requests before they
 * reach here, but that's defense-in-depth, not the primary control.
 *
 * Mock mode allows access unconditionally, same rationale as `requireAdmin()`.
 */
export async function requireAuth(): Promise<AuthedProfile | null> {
  if (IS_MOCK_MODE) {
    return { userId: MOCK_CURRENT_PROFILE.id, profile: MOCK_CURRENT_PROFILE }
  }

  return getRequestProfile()
}

/**
 * Server-side gate for merchant-only routes (`/dashboard/merchant/*`).
 * `'both'` profiles (renter + merchant) count as merchants here — the two
 * roles aren't mutually exclusive in this platform's model.
 */
export async function requireMerchant(): Promise<AuthedProfile | null> {
  const result = await requireAuth()
  if (!result) return null
  if (result.profile.role !== 'merchant' && result.profile.role !== 'both') return null
  return result
}
