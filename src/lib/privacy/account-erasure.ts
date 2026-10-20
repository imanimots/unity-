import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Safe, generic category labels for blocked_categories returned by the
 * erase_account() RPC (supabase/migrations/20261022000000_account_erasure.sql).
 * Deliberately never names a specific booking/order/dispute id -- "do not
 * leak unrelated transaction details" per the brief this was built against.
 */
export const ACTIVE_OBLIGATION_LABELS: Record<string, string> = {
  active_booking: 'an active or pending rental booking',
  open_dispute: 'an unresolved dispute',
  unsettled_order: 'an order that has not yet been delivered or cancelled',
  active_rent_to_buy: 'an active rent-to-buy agreement',
  active_barter: 'an active barter trade',
  unpaid_merchant_payout: 'a payout that has not yet been paid out to you',
  pending_refund: 'a refund that is still being processed',
}

export function describeBlockedCategories(categories: string[]): string[] {
  return categories.map((c) => ACTIVE_OBLIGATION_LABELS[c] ?? 'an unresolved obligation')
}

export type EraseAccountResult =
  | { blocked: true; blockedCategories: string[] }
  | { blocked: false; alreadyErased: boolean }

/**
 * Thin wrapper around the erase_account() RPC -- same shape as every other
 * admin/privileged RPC wrapper in this codebase (e.g.
 * src/lib/admin/users-service.ts's setUserAccountStatus). Never called
 * directly by a route without also calling runPostErasureCleanup()
 * afterward when the result is not blocked.
 */
export async function eraseAccount(
  admin: SupabaseClient,
  userId: string,
  actorId: string,
  requestSource: 'self_service' | 'admin',
  idempotencyKey: string | undefined
) {
  return admin.rpc('erase_account', {
    p_user_id: userId,
    p_actor_id: actorId,
    p_request_source: requestSource,
    p_idempotency_key: idempotencyKey ?? null,
  })
}

export function parseEraseAccountResult(data: unknown): EraseAccountResult {
  const row = data as { blocked?: boolean; blocked_categories?: string[]; already_erased?: boolean } | null
  if (row?.blocked) {
    return { blocked: true, blockedCategories: row.blocked_categories ?? [] }
  }
  return { blocked: false, alreadyErased: row?.already_erased ?? false }
}

const KYC_DOCUMENT_TYPES = ['identity_document', 'proof_of_address'] as const

export type CleanupCategory = 'avatar_cleanup' | 'kyc_document_cleanup' | 'auth_identity_ban'

export interface CleanupResult {
  /** true only when every category below has genuinely completed. */
  complete: boolean
  /** Safe, generic category labels -- never a storage path or raw error. */
  pending: CleanupCategory[]
}

interface CleanupStatusRow {
  auth_ban_complete: boolean
  avatar_cleanup_complete: boolean
  kyc_cleanup_complete: boolean
  attempt_count: number
}

/**
 * Reads the durable cleanup-status row for this user, if one exists yet.
 * Never throws -- a read failure is treated the same as "no row yet" (every
 * category re-attempted), which is always safe since every step below is
 * itself idempotent.
 */
async function getCleanupStatus(admin: SupabaseClient, userId: string): Promise<CleanupStatusRow | null> {
  try {
    const { data } = await admin
      .from('account_erasure_cleanup')
      .select('auth_ban_complete, avatar_cleanup_complete, kyc_cleanup_complete, attempt_count')
      .eq('user_id', userId)
      .maybeSingle()
    return data ?? null
  } catch {
    return null
  }
}

/**
 * Upserts the durable cleanup-status row. Never throws -- if this write
 * itself fails, the next retry simply re-attempts every category again
 * (safe, since every step is idempotent), rather than crashing the erasure
 * flow over what is itself just a bookkeeping record.
 */
async function upsertCleanupStatus(
  admin: SupabaseClient,
  userId: string,
  status: { authBanComplete: boolean; avatarCleanupComplete: boolean; kycCleanupComplete: boolean },
  previousAttemptCount: number
): Promise<void> {
  try {
    await admin.from('account_erasure_cleanup').upsert(
      {
        user_id: userId,
        auth_ban_complete: status.authBanComplete,
        avatar_cleanup_complete: status.avatarCleanupComplete,
        kyc_cleanup_complete: status.kycCleanupComplete,
        attempt_count: previousAttemptCount + 1,
        last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
  } catch (err) {
    console.error('[account-erasure] cleanup-status upsert failed', { userId: userId.slice(0, 8), err })
  }
}

/**
 * Deletes everything under this user's own namespace in `avatars` --
 * pure PII, never evidentiary. The prefix is always built from the
 * server-derived userId, never from client input. Returns true only on
 * genuine success (an empty listing counts as success -- nothing to
 * delete); false on any thrown error, so the caller can record it as
 * still-pending rather than silently assuming it worked.
 */
async function cleanupAvatarStorage(admin: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data: avatarFiles, error: listError } = await admin.storage.from('avatars').list(userId)
    if (listError) throw listError
    const avatarPaths = (avatarFiles ?? []).map((f) => `${userId}/${f.name}`)
    if (avatarPaths.length > 0) {
      const { error: removeError } = await admin.storage.from('avatars').remove(avatarPaths)
      if (removeError) throw removeError
    }
    return true
  } catch (err) {
    console.error('[account-erasure] avatar storage cleanup failed', { userId: userId.slice(0, 8), err })
    return false
  }
}

/** Same contract as cleanupAvatarStorage, for the two kyc-documents subfolders. */
async function cleanupKycStorage(admin: SupabaseClient, userId: string): Promise<boolean> {
  let ok = true
  for (const docType of KYC_DOCUMENT_TYPES) {
    try {
      const { data: files, error: listError } = await admin.storage.from('kyc-documents').list(`${userId}/${docType}`)
      if (listError) throw listError
      const paths = (files ?? []).map((f) => `${userId}/${docType}/${f.name}`)
      if (paths.length > 0) {
        const { error: removeError } = await admin.storage.from('kyc-documents').remove(paths)
        if (removeError) throw removeError
      }
    } catch (err) {
      console.error('[account-erasure] kyc document storage cleanup failed', { userId: userId.slice(0, 8), docType, err })
      ok = false
    }
  }
  return ok
}

/**
 * Disables the Supabase Auth identity without deleting it (deleting
 * auth.users is unsafe here -- see the migration's header comment). A ban
 * blocks new sign-in and token refresh; an already-issued, still-valid
 * access token can remain usable until its own short expiry elapses. There
 * is no first-party "revoke every existing session for this user id"
 * primitive in the Supabase Admin API used elsewhere in this codebase, so
 * that residual window is a known, documented limitation, not an oversight.
 * '876000h' (~100 years) is the standard community-documented pattern for
 * an effectively permanent ban, since the API has no literal "forever".
 * Returns true only on genuine success.
 */
async function disableAuthIdentity(admin: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' })
    if (error) throw error
    return true
  } catch (err) {
    console.error('[account-erasure] auth identity disable failed', { userId: userId.slice(0, 8), err })
    return false
  }
}

/**
 * Runs post-erasure external cleanup and durably records exactly which
 * categories completed. Never throws. Only re-attempts categories that are
 * NOT already recorded complete (reading the existing status row first) --
 * safe either way since every step is itself idempotent, but this avoids
 * redundant storage/auth-admin calls on a routine retry. The resulting
 * `pending` list is safe, generic category labels only -- never a raw
 * provider/storage error, never a storage path.
 */
export async function runPostErasureCleanup(admin: SupabaseClient, userId: string): Promise<CleanupResult> {
  const existing = await getCleanupStatus(admin, userId)

  const avatarCleanupComplete = existing?.avatar_cleanup_complete ? true : await cleanupAvatarStorage(admin, userId)
  const kycCleanupComplete = existing?.kyc_cleanup_complete ? true : await cleanupKycStorage(admin, userId)
  const authBanComplete = existing?.auth_ban_complete ? true : await disableAuthIdentity(admin, userId)

  await upsertCleanupStatus(
    admin,
    userId,
    { authBanComplete, avatarCleanupComplete, kycCleanupComplete },
    existing?.attempt_count ?? 0
  )

  const pending: CleanupCategory[] = []
  if (!avatarCleanupComplete) pending.push('avatar_cleanup')
  if (!kycCleanupComplete) pending.push('kyc_document_cleanup')
  if (!authBanComplete) pending.push('auth_identity_ban')

  return { complete: pending.length === 0, pending }
}

export function mapAccountErasureRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('use the self-service erasure flow for your own account')) {
    return { status: 403, error: 'Use the account privacy page to erase your own account.' }
  }
  if (m.includes('user not found')) {
    return { status: 404, error: 'User not found.' }
  }
  if (m.includes('invalid request source') || m.includes('not authenticated') || m.includes('not authorized')) {
    return { status: 401, error: 'You must be signed in to do this.' }
  }

  return { status: 500, error: 'Could not complete this request — please try again' }
}
