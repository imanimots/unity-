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

/**
 * Best-effort, never-throwing cleanup of the two buckets that hold pure PII
 * (never evidentiary/transaction records -- those are deliberately left
 * untouched, see the migration's header comment). Safe to call every time
 * erase_account() reports status 'erased', whether this call newly
 * transitioned the account or found it already erased -- removing an
 * already-removed object is a no-op, giving natural self-healing if a
 * prior attempt's cleanup partially failed.
 */
export async function cleanupErasedAccountStorage(admin: SupabaseClient, userId: string): Promise<void> {
  try {
    const { data: avatarFiles } = await admin.storage.from('avatars').list(userId)
    const avatarPaths = (avatarFiles ?? []).map((f) => `${userId}/${f.name}`)
    if (avatarPaths.length > 0) {
      await admin.storage.from('avatars').remove(avatarPaths)
    }
  } catch (err) {
    console.error('[account-erasure] avatar storage cleanup failed', { userId: userId.slice(0, 8), err })
  }

  for (const docType of KYC_DOCUMENT_TYPES) {
    try {
      const { data: files } = await admin.storage.from('kyc-documents').list(`${userId}/${docType}`)
      const paths = (files ?? []).map((f) => `${userId}/${docType}/${f.name}`)
      if (paths.length > 0) {
        await admin.storage.from('kyc-documents').remove(paths)
      }
    } catch (err) {
      console.error('[account-erasure] kyc document storage cleanup failed', { userId: userId.slice(0, 8), docType, err })
    }
  }
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
 */
export async function disableErasedAccountAuthIdentity(admin: SupabaseClient, userId: string): Promise<void> {
  try {
    await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' })
  } catch (err) {
    console.error('[account-erasure] auth identity disable failed', { userId: userId.slice(0, 8), err })
  }
}

/** Runs both best-effort post-erasure cleanup steps. Never throws. */
export async function runPostErasureCleanup(admin: SupabaseClient, userId: string): Promise<void> {
  await cleanupErasedAccountStorage(admin, userId)
  await disableErasedAccountAuthIdentity(admin, userId)
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
