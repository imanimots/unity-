import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { scheduleMilestoneSchema } from '@/lib/barter/skill-task-validation'
import { mapBarterRpcError } from '@/lib/barter/rpc-errors'

interface RouteParams {
  params: Promise<{ id: string; milestoneId: string }>
}

/**
 * POST /api/barter/[id]/milestones/[milestoneId]/schedule -- either
 * party proposes an in-person date/time/location for a milestone.
 * The other party must separately confirm (see the confirm/ route)
 * before the milestone can be completed.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { milestoneId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(milestoneId)) {
    return NextResponse.json({ error: 'Invalid milestone id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`barter:milestone:schedule:${getClientKey(request)}`, 20, 60_000)
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

  const parsed = scheduleMilestoneSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid schedule', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  try {
    const { createClient: createServiceClient } = await import('@supabase/supabase-js')
    const admin = createServiceClient(url, serviceKey)

    const { data, error } = await admin.rpc('propose_milestone_schedule', {
      p_actor_user_id: requester.userId,
      p_milestone_id: milestoneId,
      p_scheduled_at: parsed.data.scheduled_at,
      p_scheduled_city: parsed.data.scheduled_city,
      p_scheduled_province: parsed.data.scheduled_province,
      p_idempotency_key: parsed.data.idempotency_key ?? null,
    })

    if (error) {
      console.error('[barter.milestone.schedule] RPC error', { userId: requester.userId, milestoneId, error })
      const mapped = mapBarterRpcError(error.message)
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[barter.milestone.schedule] unexpected error', { userId: requester.userId, milestoneId, err })
    return NextResponse.json({ error: 'Could not propose a schedule — please try again' }, { status: 500 })
  }
}
