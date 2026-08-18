import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { recordPersonalizationView } from '@/lib/personalization/signals'

const viewSchema = z.object({
  entityType: z.enum(['listing', 'marketplace_request', 'barter_skill_task_post']),
  entityId: z.string().uuid(),
  mode: z.enum(['buy', 'rent', 'barter']).nullable().optional(),
  category: z.string().nullable().optional(),
  kind: z.enum(['item', 'skill', 'task']).nullable().optional(),
  province: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
})

/**
 * POST /api/personalization/view -- records ONE meaningful view for a
 * signed-in user (Section 13). Anonymous views never reach the server
 * at all -- they're written straight to the browser-local buffer
 * (src/lib/personalization/anonymous.ts), which is the whole point of
 * "must NOT require a server-side anonymous identity" (Section 1).
 * Always returns 200 even when personalization is disabled/unconfigured
 * -- a view is presentation telemetry, never something the calling page
 * should treat as a hard failure.
 */
export async function POST(request: NextRequest) {
  if (!isPersonalizationEnabled()) return NextResponse.json({ ok: true })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ ok: true }) // anonymous: no-op, client handles locally

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: true })
  }
  const parsed = viewSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ ok: true })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ ok: true })

  await recordPersonalizationView(admin, requester.userId, {
    entityType: parsed.data.entityType,
    entityId: parsed.data.entityId,
    mode: parsed.data.mode ?? null,
    category: parsed.data.category ?? null,
    kind: parsed.data.kind ?? null,
    province: parsed.data.province ?? null,
    city: parsed.data.city ?? null,
  })

  return NextResponse.json({ ok: true })
}
