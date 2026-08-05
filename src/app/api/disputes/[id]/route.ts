import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/disputes/[id] -- full dispute detail for a party. Uses the
 * session client throughout -- RLS ("disputes: parties read" and the
 * equivalent is_dispute_participant()-backed policies on
 * dispute_history/dispute_evidence) is the actual enforcement boundary,
 * same pattern as GET /api/barter/[id].
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id: disputeId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(disputeId)) {
    return NextResponse.json({ error: 'Invalid dispute id' }, { status: 400 })
  }

  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Dispute storage is not configured' }, { status: 503 })
  }

  const { data: dispute, error: disputeError } = await supabase
    .from('disputes')
    .select('*')
    .eq('id', disputeId)
    .maybeSingle()

  if (disputeError) {
    console.error('[disputes.detail] error', { userId: requester.userId, disputeId, error: disputeError })
    return NextResponse.json({ error: 'Could not load this dispute' }, { status: 500 })
  }
  if (!dispute) {
    // RLS makes a non-party's row indistinguishable from a nonexistent one.
    return NextResponse.json({ error: 'Dispute not found' }, { status: 404 })
  }

  const [{ data: history }, { data: evidence }] = await Promise.all([
    supabase.from('dispute_history').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
    supabase.from('dispute_evidence').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
  ])

  return NextResponse.json({
    dispute,
    history: history ?? [],
    evidence: evidence ?? [],
  })
}
