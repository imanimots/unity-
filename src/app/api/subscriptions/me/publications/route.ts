import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'

export interface MerchantPublicationSummary {
  entityType: 'listing' | 'marketplace_request' | 'barter_skill_task_post'
  entityId: string
  title: string
  createdAt: string
}

/**
 * GET /api/subscriptions/me/publications -- the caller's own currently
 * active/open published entities across all three canonical tables,
 * for the downgrade keep-set picker (Section 55). Real content only
 * (is_test excluded), same predicate as _lock_and_count_active_supply.
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Subscription storage is not configured' }, { status: 503 })
  }

  try {
    const [listings, requests, posts] = await Promise.all([
      admin.from('listings').select('id, title, created_at').eq('merchant_id', requester.userId).eq('status', 'active').eq('is_test', false),
      admin.from('marketplace_requests').select('id, title, created_at').eq('requester_id', requester.userId).in('status', ['active', 'offers_received']).eq('is_test', false),
      admin.from('barter_skill_task_posts').select('id, title, created_at').eq('owner_id', requester.userId).in('status', ['active', 'offers_received']).eq('is_test', false),
    ])

    const items: MerchantPublicationSummary[] = [
      ...(listings.data ?? []).map((r) => ({ entityType: 'listing' as const, entityId: r.id, title: r.title, createdAt: r.created_at })),
      ...(requests.data ?? []).map((r) => ({ entityType: 'marketplace_request' as const, entityId: r.id, title: r.title, createdAt: r.created_at })),
      ...(posts.data ?? []).map((r) => ({ entityType: 'barter_skill_task_post' as const, entityId: r.id, title: r.title, createdAt: r.created_at })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    return NextResponse.json({ items })
  } catch (err) {
    console.error('[subscriptions.me.publications] error', { userId: requester.userId, err })
    return NextResponse.json({ error: 'Could not load your published content' }, { status: 500 })
  }
}
