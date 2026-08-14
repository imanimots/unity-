import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/barter/skill-task/[id]/offers -- the "offer inbox" for a
 * Looking-For post owner: every barter_agreements row referencing this
 * post via source_skill_task_post_id, newest first. No new table --
 * "an offer against a Looking-For post" IS a barter_agreements row
 * (see the source-link migration's own comment). RLS
 * ("barter_agreements: parties read") already scopes this correctly,
 * since the post owner is party_a for every such agreement by
 * construction -- this route just adds the source_skill_task_post_id
 * filter and a friendlier per-agreement summary shape.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id: postId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(postId)) {
    return NextResponse.json({ error: 'Invalid post id' }, { status: 400 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }

  const { data: post } = await supabase.from('barter_skill_task_posts').select('id, owner_id, direction').eq('id', postId).maybeSingle()
  if (!post || post.owner_id !== requester.userId || post.direction !== 'looking_for') {
    return NextResponse.json({ error: 'Post not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('barter_agreements')
    .select('id, agreement_reference, status, party_b_id, proposed_at, accepted_at')
    .eq('source_skill_task_post_id', postId)
    .order('proposed_at', { ascending: false })

  if (error) {
    console.error('[barter.skill-task.offers] error', { userId: requester.userId, postId, error })
    return NextResponse.json({ error: 'Could not load offers' }, { status: 500 })
  }

  return NextResponse.json({ offers: data ?? [] })
}
