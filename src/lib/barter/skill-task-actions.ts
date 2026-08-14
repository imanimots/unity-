import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'

/**
 * Shared thin-wrapper for the Skill/Task post lifecycle RPCs
 * (publish/pause/resume/close/archive/repost) -- every one of these
 * takes exactly (p_owner_id, p_post_id, p_idempotency_key) and returns
 * jsonb, so one helper avoids duplicating the same try/catch/error-map
 * shape six times. Typed against the real SupabaseClient (not a
 * hand-rolled narrow interface) -- a narrow interface is structurally
 * incompatible with the real client's thenable PostgrestFilterBuilder
 * chain.
 */
export async function callSkillTaskOwnerRpc(
  admin: SupabaseClient,
  rpcName: string,
  ownerId: string,
  postId: string,
  idempotencyKey: string | null | undefined,
  logLabel: string
): Promise<NextResponse> {
  const { data, error } = await admin.rpc(rpcName, {
    p_owner_id: ownerId,
    p_post_id: postId,
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    console.error(`[${logLabel}] RPC error`, { ownerId, postId, error })
    const mapped = mapBarterRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
