import type { SupabaseClient } from '@supabase/supabase-js'

export interface AdminAuthInfo {
  authUserExists: true
  erased: false
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

/**
 * The entire response shape for an erased account's Auth & Access panel.
 * Deliberately has NO email/phone/user_metadata/identities field at
 * all -- not nulled, not present -- so there is no field for a future
 * edit to accidentally repopulate. See getAdminAuthInfoRespectingErasure.
 */
export interface ErasedAdminAuthInfo {
  authUserExists: true
  erased: true
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
 *
 * CALLERS MUST NOT call this function directly for an erased profile --
 * use getAdminAuthInfoRespectingErasure below, which is the only
 * entry point that knows about erasure at all. This function has no
 * way to protect anyone on its own: it is a pure, unconditional mirror
 * of whatever auth.users currently holds, including email/phone that
 * account erasure's own disableAuthIdentity() (src/lib/privacy/
 * account-erasure.ts) deliberately never scrubs -- it only bans the
 * identity (ban_duration), by design (see that function's own header
 * comment on why a full session/field wipe isn't attempted there).
 */
export async function getAdminAuthInfo(admin: SupabaseClient, authUserId: string): Promise<AdminAuthInfo | null> {
  const { data, error } = await admin.auth.admin.getUserById(authUserId)
  if (error || !data?.user) return null

  const user = data.user
  const factors = user.factors ?? []

  return {
    authUserExists: true,
    erased: false,
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

/**
 * ADMIN-CONTROL-CENTRE-BATCH-A1-P1-REMEDIATION: the ONLY entry point the
 * Customer 360 / Merchant 360 auth-info route should call -- it is the
 * single place that knows erasure must change this panel's behavior at
 * all. When `isErased` is true, this deliberately NEVER calls
 * getAdminAuthInfo / auth.admin.getUserById in the first place ("skip
 * the Auth PII lookup entirely for erased accounts") -- email, phone,
 * and every other Auth-provider field are never fetched, never held in
 * server memory for this request, and therefore structurally cannot
 * appear in the JSON this route returns. The caller is responsible for
 * knowing `isErased` from the profile row it already has (this module
 * has no `profiles` table dependency of its own, by design).
 */
export async function getAdminAuthInfoRespectingErasure(
  admin: SupabaseClient,
  authUserId: string,
  isErased: boolean
): Promise<AdminAuthInfo | ErasedAdminAuthInfo | null> {
  if (isErased) {
    return { authUserExists: true, erased: true }
  }
  return getAdminAuthInfo(admin, authUserId)
}
