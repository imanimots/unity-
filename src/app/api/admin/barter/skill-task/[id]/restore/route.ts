import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { adminRestoreSkillTaskPostSchema } from '@/lib/barter/skill-task-validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/admin/barter/skill-task/[id]/restore -- restores the
 * post's captured pre_suspend_status (never a blind reset to
 * 'active'). If the prior status was 'active' and the owner's
 * active-supply cap is now full, the RPC leaves the post suspended
 * and returns a normalized capacity error instead of exceeding the
 * cap.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: postId } = await params
  if (!isValidUuid(postId)) {
    return NextResponse.json({ error: 'Invalid post id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:barter:skill-task:restore')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = adminRestoreSkillTaskPostSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('admin_restore_barter_skill_task_post', {
    p_admin_id: gate.requester.userId,
    p_post_id: postId,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotency_key ?? null,
  })

  if (error) {
    console.error('[admin.barter.skill-task.restore] RPC error', { postId, error })
    const mapped = mapBarterRpcError(error.message)
    return NextResponse.json({ error: mapped.error }, { status: mapped.status })
  }

  return NextResponse.json(data)
}
