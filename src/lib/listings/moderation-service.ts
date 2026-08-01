import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Thin service-layer wrappers around the moderation/activation RPCs
 * (20260803000003_admin_moderation_rpcs.sql) -- not a pluggable provider
 * abstraction like ownership verification, since moderation policy itself
 * isn't something a future third-party service replaces the way ownership
 * evidence review might be. Each function is a direct, single RPC call;
 * error mapping is the caller's job (mapAdminRpcError), matching how
 * every other RPC call site in this codebase is structured.
 */

export type ModerationDecision = 'approved' | 'rejected' | 'requires_review' | 'flagged'

export async function decideModeration(
  admin: SupabaseClient,
  listingId: string,
  adminId: string,
  decision: ModerationDecision,
  reasonCode: string | null,
  internalNote: string | null,
  merchantFeedback: string | null,
  idempotencyKey?: string
) {
  return admin.rpc('decide_moderation', {
    p_listing_id: listingId,
    p_admin_id: adminId,
    p_decision: decision,
    p_reason_code: reasonCode,
    p_internal_note: internalNote,
    p_merchant_feedback: merchantFeedback,
    p_idempotency_key: idempotencyKey ?? null,
  })
}

export async function activateListing(admin: SupabaseClient, listingId: string, adminId: string, idempotencyKey?: string) {
  return admin.rpc('activate_listing', {
    p_listing_id: listingId,
    p_admin_id: adminId,
    p_idempotency_key: idempotencyKey ?? null,
  })
}

export async function suspendListing(
  admin: SupabaseClient,
  listingId: string,
  adminId: string,
  reasonCode: string | null,
  internalNote: string | null,
  merchantFeedback: string | null,
  idempotencyKey?: string
) {
  return admin.rpc('suspend_listing', {
    p_listing_id: listingId,
    p_admin_id: adminId,
    p_reason_code: reasonCode,
    p_internal_note: internalNote,
    p_merchant_feedback: merchantFeedback,
    p_idempotency_key: idempotencyKey ?? null,
  })
}
