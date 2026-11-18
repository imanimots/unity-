import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Platform improvement programme follow-up (E46): admin MFA
 * enforcement, feature-flagged and OFF by default. requireAdmin()
 * calls isAdminMfaEnforced() first -- when unset/false, behavior is
 * byte-identical to before this file existed. Flipping ADMIN_MFA_ENFORCED
 * to true without first confirming every current admin has enrolled a
 * verified factor WILL lock out any admin who hasn't -- see
 * docs/operations/ADMIN_MFA_ROLLOUT_CHECKLIST.md, which exists
 * specifically so this flag is never flipped as a surprise.
 *
 * Uses Supabase Auth's own MFA primitives (getAuthenticatorAssuranceLevel)
 * -- never a custom/hand-rolled second-factor mechanism.
 */
export function isAdminMfaEnforced(): boolean {
  return process.env.ADMIN_MFA_ENFORCED === 'true'
}

/**
 * True only when the CURRENT session has actually authenticated with a
 * verified MFA factor (aal2), not merely "a factor exists but wasn't
 * used this session." Supabase's own documented contract: nextLevel is
 * 'aal2' whenever the user has at least one verified factor, regardless
 * of currentLevel -- so an admin who enrolled a factor but is still on
 * an aal1 session (e.g. a session that predates enrollment, or one
 * where they skipped the challenge) is correctly rejected here, not
 * waved through just because enrollment technically happened at some
 * point.
 */
export async function hasVerifiedAdminMfaSession(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return false

  const cookieStore = await cookies()
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll() {
        // Called from a server component context -- middleware handles
        // refresh, same convention as getRequestProfile().
      },
    },
  })

  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (error || !data) return false

  return data.currentLevel === 'aal2'
}
