import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { saveSkillTaskPostDraftSchema } from '@/lib/barter/skill-task-validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'
import { blockIfCannotCreate } from '@/lib/admin/account-status'

/**
 * POST /api/barter/skill-task -- create (or update, via body.post_id) a
 * draft Skill/Task post. save_barter_skill_task_post_draft() is the
 * authoritative RPC -- KYC is deliberately NOT required at draft stage
 * (mirrors create_marketplace_request's own "draft creation: no KYC
 * required" precedent), only at publish.
 *
 * GET /api/barter/skill-task -- list the caller's own posts (any status).
 * Public browsing goes through barter_skill_task_public_posts directly
 * (no route needed -- it's a plain, safe, anon/authenticated-readable view).
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`barter:skill-task:save:${getClientKey(request)}`, 20, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please slow down' }, { status: 429 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }
  const blocked = blockIfCannotCreate(requester.profile)
  if (blocked) return blocked

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = saveSkillTaskPostDraftSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid Skill/Task post', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const bodyRecord = body as Record<string, unknown>
  const postId = typeof bodyRecord.post_id === 'string' ? bodyRecord.post_id : null

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('save_barter_skill_task_post_draft', {
      p_owner_id: requester.userId,
      p_post_id: postId,
      p_kind: parsed.data.kind ?? null,
      p_direction: parsed.data.direction ?? null,
      p_title: parsed.data.title ?? null,
      p_description: parsed.data.description ?? null,
      p_category_slug: parsed.data.category_slug ?? null,
      p_delivery_mode: parsed.data.delivery_mode ?? null,
      p_province: parsed.data.province ?? null,
      p_city: parsed.data.city ?? null,
      p_exclusions: parsed.data.exclusions ?? null,
      p_materials_arrangement: parsed.data.materials_arrangement ?? null,
      p_evidence_expectations: parsed.data.evidence_expectations ?? null,
      p_desired_exchange_notes: parsed.data.desired_exchange_notes ?? null,
      p_wants_item: parsed.data.wants_item ?? false,
      p_wants_skill: parsed.data.wants_skill ?? false,
      p_wants_task: parsed.data.wants_task ?? false,
      p_wants_cash_adjustment: parsed.data.wants_cash_adjustment ?? false,
      p_availability_notes: parsed.data.availability_notes ?? null,
      p_preferred_start_date: parsed.data.preferred_start_date ?? null,
      p_preferred_start_time: parsed.data.preferred_start_time ?? null,
      p_deadline: parsed.data.deadline ?? null,
      p_expected_duration_notes: parsed.data.expected_duration_notes ?? null,
      p_milestone_templates: parsed.data.milestone_templates ?? [],
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.skill-task.save] RPC error', { userId: requester.userId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json({ post_id: data }, { status: postId ? 200 : 201 })
  } catch (err) {
    console.error('[barter.skill-task.save] unexpected error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not save your Skill/Task post — please try again' }, { status: 500 })
  }
}

export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const { data, error } = await supabase
    .from('barter_skill_task_posts')
    .select('*')
    .eq('owner_id', requester.userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[barter.skill-task.list] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load your Skill/Task posts' }, { status: 500 })
  }

  return NextResponse.json({ posts: data ?? [] })
}
