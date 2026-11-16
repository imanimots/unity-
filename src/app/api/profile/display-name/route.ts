import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { displayNameUpdateSchema } from '@/lib/profile/validation'

/**
 * PATCH /api/profile/display-name -- mirrors /api/profile/country exactly.
 * One narrow, single-purpose route for an authenticated user to change
 * their own display name (the "Edit profile" action on the Profile page,
 * E47 Phase H). Writes exactly one column, only for the caller's own row
 * (session-scoped client, "profiles: own update" RLS, never a
 * client-supplied user id).
 */
export async function PATCH(request: NextRequest) {
  const rate = await checkRateLimit(`profile:display-name:${getClientKey(request)}`, 20, 60_000)
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

  const parsed = displayNameUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({ display_name: parsed.data.display_name })
    .eq('id', requester.userId)
    .select('display_name')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Could not update your name' }, { status: 500 })
  }

  return NextResponse.json({ display_name: data.display_name })
}
