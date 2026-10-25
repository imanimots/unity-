import type { SupabaseClient } from '@supabase/supabase-js'

export interface AdminAuthInfo {
  authUserExists: true
  email: string | null
  emailConfirmedAt: string | null
  phone: string | null
  phoneConfirmedAt: string | null
  lastSignInAt: string | null
  createdAt: string | null
  updatedAt: string | null
  bannedUntil: string | null
  mfaFactorCount: number
  mfaVerifiedFactorCount: number
  lastRecoveryEmailSentAt: string | null
  lastConfirmationEmailSentAt: string | null
}

export const AUTH_FIELD_NOT_AVAILABLE = 'NOT AVAILABLE VIA CURRENT AUTH API' as const

/**
 * Read-only wrapper around Supabase's server-side Admin Auth API
 * (`supabase.auth.admin.getUserById`) -- server-only, never reachable
 * from the browser (the caller must already hold a service-role
 * client). Only returns fields the installed @supabase/auth-js SDK's
 * own `User` type genuinely exposes (confirmed directly from
 * node_modules/@supabase/auth-js/dist/module/lib/types.d.ts, not
 * assumed from documentation): email/phone confirmation timestamps,
 * last_sign_in_at, created_at/updated_at, banned_until, MFA factors
 * (status is 'verified' | 'unverified' per the SDK's own Factor type),
 * and the last recovery/confirmation email timestamps
 * (recovery_sent_at / confirmation_sent_at).
 *
 * Deliberately NOT exposed because the Admin Auth API has no method for
 * them (see AUTH_FIELD_NOT_AVAILABLE, used by callers): a failed-login
 * attempt count, and a list of currently active sessions. Never
 * fabricate either -- callers must render AUTH_FIELD_NOT_AVAILABLE
 * instead of guessing.
 */
export async function getAdminAuthInfo(admin: SupabaseClient, authUserId: string): Promise<AdminAuthInfo | null> {
  const { data, error } = await admin.auth.admin.getUserById(authUserId)
  if (error || !data?.user) return null

  const user = data.user
  const factors = user.factors ?? []

  return {
    authUserExists: true,
    email: user.email ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    phone: user.phone ?? null,
    phoneConfirmedAt: user.phone_confirmed_at ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
    createdAt: user.created_at ?? null,
    updatedAt: user.updated_at ?? null,
    bannedUntil: user.banned_until ?? null,
    mfaFactorCount: factors.length,
    mfaVerifiedFactorCount: factors.filter((f) => f.status === 'verified').length,
    lastRecoveryEmailSentAt: user.recovery_sent_at ?? null,
    lastConfirmationEmailSentAt: user.confirmation_sent_at ?? null,
  }
}
