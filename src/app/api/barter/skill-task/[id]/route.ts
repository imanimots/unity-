import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { updateSkillTaskPostSchema } from '@/lib/barter/skill-task-validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/barter/skill-task/[id] -- public detail (via the safe
 * explicit-column view) for anyone; if the caller is the owner, the
 * full (private-field-inclusive) row is returned instead via the
 * owner-scoped base-table RLS path.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id: postId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(postId)) {
    return NextResponse.json({ error: 'Invalid post id' }, { status: 400 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const requester = await getRequestProfile()
  if (requester) {
    const { data: own } = await supabase.from('barter_skill_task_posts').select('*').eq('id', postId).eq('owner_id', requester.userId).maybeSingle()
    if (own) return NextResponse.json({ post: own, viewer_is_owner: true })
  }

  const { data: pub, error } = await supabase.from('barter_skill_task_public_posts').select('*').eq('id', postId).maybeSingle()
  if (error || !pub) {
    return NextResponse.json({ error: 'Post not found' }, { status: 404 })
  }
  return NextResponse.json({ post: pub, viewer_is_owner: false })
}

/**
 * PATCH /api/barter/skill-task/[id] -- post-publish edit. Deliberately
 * cannot change kind/direction (no such fields in the schema) --
 * update_barter_skill_task_post() structurally has no parameter for
 * them.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id: postId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(postId)) {
    return NextResponse.json({ error: 'Invalid post id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`barter:skill-task:update:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = updateSkillTaskPostSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid update', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('update_barter_skill_task_post', {
      p_owner_id: requester.userId,
      p_post_id: postId,
      p_title: parsed.data.title ?? null,
      p_description: parsed.data.description ?? null,
      p_delivery_mode: parsed.data.delivery_mode ?? null,
      p_province: parsed.data.province ?? null,
      p_city: parsed.data.city ?? null,
      p_exclusions: parsed.data.exclusions ?? null,
      p_materials_arrangement: parsed.data.materials_arrangement ?? null,
      p_evidence_expectations: parsed.data.evidence_expectations ?? null,
      p_desired_exchange_notes: parsed.data.desired_exchange_notes ?? null,
      p_availability_notes: parsed.data.availability_notes ?? null,
      p_preferred_start_date: parsed.data.preferred_start_date ?? null,
      p_preferred_start_time: parsed.data.preferred_start_time ?? null,
      p_deadline: parsed.data.deadline ?? null,
      p_expected_duration_notes: parsed.data.expected_duration_notes ?? null,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.skill-task.update] RPC error', { userId: requester.userId, postId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[barter.skill-task.update] unexpected error', { userId: requester.userId, postId, err })
    return NextResponse.json({ error: 'Could not update your post — please try again' }, { status: 500 })
  }
}
