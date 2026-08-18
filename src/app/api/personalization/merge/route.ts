import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { isPersonalizationEnabled } from '@/lib/personalization/config'

const mergeSchema = z.object({
  events: z
    .array(
      z.object({
        entityType: z.enum(['listing', 'marketplace_request', 'barter_skill_task_post']),
        entityId: z.string().uuid(),
        mode: z.enum(['buy', 'rent', 'barter']).nullable().optional(),
        category: z.string().nullable().optional(),
        kind: z.enum(['item', 'skill', 'task']).nullable().optional(),
        province: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
      })
    )
    .max(100),
})

/**
 * POST /api/personalization/merge -- Section 40/41: merges the
 * anonymous browser's local view buffer into the just-authenticated
 * user's server-side history, ONE TIME per sign-in (the client marks
 * its local buffer merged immediately after a 200 here -- see
 * markAnonymousHistoryMerged() in anonymous.ts). Idempotent at the DB
 * layer too (upsert-by-entity), so a retried/duplicate call is always
 * safe. Never called for anything other than the browser's OWN local
 * buffer, at the moment of actual sign-in in that browser (Section 41)
 * -- there is no server-side anonymous identity to merge FROM.
 */
export async function POST(request: NextRequest) {
  if (!isPersonalizationEnabled()) return NextResponse.json({ merged: 0 })

  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = mergeSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ merged: 0 })
  if (parsed.data.events.length === 0) return NextResponse.json({ merged: 0 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ merged: 0 })

  const { data, error } = await admin.rpc('merge_anonymous_personalization_views', {
    p_user_id: requester.userId,
    p_events: parsed.data.events,
  })

  if (error) return NextResponse.json({ merged: 0 })
  return NextResponse.json({ merged: data ?? 0 })
}
