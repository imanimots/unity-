import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { skillTaskLifecycleActionSchema } from '@/lib/barter/skill-task-validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/barter/skill-task/[id]/repost -- clones public terms into a
 * new draft row, never mutating the original (mirrors
 * repost_marketplace_request's exact pattern).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: postId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(postId)) {
    return NextResponse.json({ error: 'Invalid post id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`barter:skill-task:repost:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    // no body is fine
  }
  const parsed = skillTaskLifecycleActionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('repost_barter_skill_task_post', {
      p_owner_id: requester.userId,
      p_post_id: postId,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.skill-task.repost] RPC error', { userId: requester.userId, postId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json({ new_post_id: data }, { status: 201 })
  } catch (err) {
    console.error('[barter.skill-task.repost] unexpected error', { userId: requester.userId, postId, err })
    return NextResponse.json({ error: 'Could not repost — please try again' }, { status: 500 })
  }
}
