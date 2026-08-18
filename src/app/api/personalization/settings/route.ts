import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { getPersonalizationSettings, updatePersonalizationSettings } from '@/lib/personalization/preferences'

const updateSchema = z.object({
  personalizationEnabled: z.boolean().optional(),
  preferredModes: z.array(z.enum(['buy', 'rent', 'barter'])).max(3).optional(),
  preferredCategories: z.array(z.string()).max(20).optional(),
  preferredBarterKinds: z.array(z.enum(['item', 'skill', 'task'])).max(3).optional(),
  interestedLookingFor: z.boolean().optional(),
  interestedRtb: z.boolean().optional(),
  preferredProvince: z.string().max(100).nullable().optional(),
  preferredCity: z.string().max(100).nullable().optional(),
})

export async function GET() {
  if (!isPersonalizationEnabled()) {
    return NextResponse.json({ error: 'Personalization is not enabled' }, { status: 404 })
  }
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Personalization storage is not configured' }, { status: 503 })

  const settings = await getPersonalizationSettings(admin, requester.userId)
  return NextResponse.json({ settings })
}

export async function POST(request: NextRequest) {
  if (!isPersonalizationEnabled()) {
    return NextResponse.json({ error: 'Personalization is not enabled' }, { status: 404 })
  }
  const requester = await getRequestProfile()
  if (!requester) return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) return NextResponse.json({ error: 'Personalization storage is not configured' }, { status: 503 })

  const result = await updatePersonalizationSettings(admin, requester.userId, parsed.data)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 503 })
  }

  const settings = await getPersonalizationSettings(admin, requester.userId)
  return NextResponse.json({ settings })
}
