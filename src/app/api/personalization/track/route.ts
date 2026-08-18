import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { isPersonalizationEnabled } from '@/lib/personalization/config'

const trackSchema = z.object({
  eventType: z.enum(['impression', 'click']),
  module: z.string().max(50),
  reasonCode: z.string().max(50),
  entityType: z.enum(['listing', 'marketplace_request', 'barter_skill_task_post']),
  entityId: z.string().uuid(),
  position: z.number().int().min(0).max(100).optional(),
})

/**
 * POST /api/personalization/track -- minimal recommendation-performance
 * instrumentation (Section 50), kept deliberately separate from
 * Advertising's ad_impressions/ad_clicks (Section 51): recommendation
 * impressions/clicks are never counted as ad impressions/clicks, and
 * this event never feeds into Advertising serve/targeting logic.
 * Anonymous callers are recorded with user_id = null, exactly like
 * Advertising's own viewer_id-nullable convention -- no fingerprinting.
 */
export async function POST(request: NextRequest) {
  if (!isPersonalizationEnabled()) return NextResponse.json({ ok: true })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: true })
  }
  const parsed = trackSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ ok: true })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ ok: true })

  const requester = await getRequestProfile()

  await admin.rpc('record_personalization_recommendation_event', {
    p_event_type: parsed.data.eventType,
    p_module: parsed.data.module,
    p_reason_code: parsed.data.reasonCode,
    p_entity_type: parsed.data.entityType,
    p_entity_id: parsed.data.entityId,
    p_position: parsed.data.position ?? null,
    p_user_id: requester?.userId ?? null,
  })

  return NextResponse.json({ ok: true })
}
