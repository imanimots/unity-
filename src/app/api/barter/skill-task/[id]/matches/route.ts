import { NextRequest, NextResponse } from 'next/server'
import { deliveryModeCompatible, computeCompatibilityCount, sortByCompatibilityDesc } from '@/lib/barter/matching'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/barter/skill-task/[id]/matches -- bidirectional matching
 * for a Skill/Task post. An 'available' anchor returns compatible
 * 'looking_for' candidates; a 'looking_for' anchor returns compatible
 * 'available' candidates (both Skill/Task posts AND item listings, so
 * "item wanted <-> Skill offered" style matches surface here too).
 * Deterministic, explainable, no numeric monetary score -- a plain
 * cumulative count of matched boolean signals, hard delivery-mode
 * incompatibility excluded before ranking, deterministic tie-break
 * (created_at DESC, id ASC).
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid post id' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Barter storage is not configured' }, { status: 503 })
  }
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data: anchor } = await admin.from('barter_skill_task_public_posts').select('*').eq('id', id).maybeSingle()
  if (!anchor) {
    return NextResponse.json({ error: 'Post not found' }, { status: 404 })
  }

  const opposingDirection = anchor.direction === 'available' ? 'looking_for' : 'available'

  const { data: candidates } = await admin
    .from('barter_skill_task_public_posts')
    .select('*')
    .eq('direction', opposingDirection)
    .eq('kind', anchor.kind)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(60)

  const withSignals = (candidates ?? [])
    .filter((c) => deliveryModeCompatible(anchor.delivery_mode, c.delivery_mode))
    .map((c) => {
      const signals = {
        categoryMatch: !!(anchor.category_id && c.category_id === anchor.category_id),
        deliveryModeCompatible: true,
        locationMatch: !!(anchor.city && c.city && anchor.city === c.city) || !!(anchor.province && c.province && anchor.province === c.province),
      }
      const compatibilityCount = computeCompatibilityCount(signals)
      return { id: c.id, created_at: c.created_at, kind: c.kind, title: c.title, signals, compatibilityCount }
    })

  const matches = sortByCompatibilityDesc(withSignals).map(({ id, created_at: _created_at, ...rest }) => {
    void _created_at
    return { post_id: id, ...rest }
  })

  // Item candidates also surface for a barter-wanting anchor -- "item
  // wanted <-> Skill/Task offered" and the reverse both need the item
  // side represented, reusing the existing want-flags on the anchor.
  let itemMatches: Array<{ listing_id: string; title: string }> = []
  if (anchor.wants_item) {
    const { data: listingCandidates } = await admin
      .from('listings')
      .select('id, title')
      .eq('status', 'active')
      .eq('is_test', false)
      .eq('direction', 'available')
      .limit(30)
    itemMatches = (listingCandidates ?? []).map((l) => ({ listing_id: l.id, title: l.title }))
  }

  return NextResponse.json({ matches, itemMatches })
}
