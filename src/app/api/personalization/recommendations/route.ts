import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { buildAuthenticatedProfile } from '@/lib/personalization/profile'
import { getRecommendationModule } from '@/lib/personalization/service'
import { resolveEffectiveCountry } from '@/lib/resolve-effective-country'
import type { PersonalizationProfileInput } from '@/lib/personalization/types'

const requestSchema = z.object({
  module: z.enum(['continue_browsing', 'recommended_for_you', 'because_you_viewed', 'near_your_area']),
  limit: z.number().int().min(1).max(24).optional(),
  // Only meaningful for anonymous callers -- the browser's own local
  // view buffer, passed in verbatim. An authenticated caller's payload
  // here is ignored; the server profile is always authoritative for a
  // signed-in user (Section 37/41: explicit server preferences are
  // never overridden by client-supplied data).
  anonymousViews: z
    .array(
      z.object({
        entityType: z.enum(['listing', 'marketplace_request', 'barter_skill_task_post']),
        entityId: z.string().uuid(),
        mode: z.enum(['buy', 'rent', 'barter']).nullable().optional(),
        category: z.string().nullable().optional(),
        kind: z.enum(['item', 'skill', 'task']).nullable().optional(),
        province: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
        viewCount: z.number().optional(),
        lastViewedAt: z.string().optional(),
      })
    )
    .max(100)
    .optional(),
})

export async function POST(request: NextRequest) {
  if (!isPersonalizationEnabled()) return NextResponse.json({ items: [] })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ items: [] })
  }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ items: [] })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ items: [] })

  const requester = await getRequestProfile()
  const { countryId } = await resolveEffectiveCountry()

  let profile: PersonalizationProfileInput
  if (requester) {
    const built = await buildAuthenticatedProfile(admin, requester.userId)
    profile = built.profile
  } else {
    profile = {
      views: (parsed.data.anonymousViews ?? []).map((e) => ({
        entityType: e.entityType,
        entityId: e.entityId,
        mode: e.mode ?? null,
        category: e.category ?? null,
        kind: e.kind ?? null,
        province: e.province ?? null,
        city: e.city ?? null,
        viewCount: e.viewCount ?? 1,
        lastViewedAt: e.lastViewedAt ?? new Date().toISOString(),
      })),
      completedCategories: [],
      completedModes: [],
      settings: null,
    }
  }

  const results = await getRecommendationModule(admin, {
    module: parsed.data.module,
    profile,
    viewerId: requester?.userId ?? null,
    countryId,
    limit: parsed.data.limit,
  })

  return NextResponse.json({
    items: results.map((r) => ({
      listing: r.listing,
      reasonCode: r.reasonCode,
      reasonContext: r.reasonContext,
    })),
  })
}
