import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isSupportedCountry, getCountry } from '@/lib/countries'
import { countryUpdateSchema } from '@/lib/profile/validation'

/**
 * PATCH /api/profile/country -- the one narrow, single-purpose route for
 * an authenticated user to change their persisted country preference.
 * Not a generic profile-mutation endpoint -- it writes exactly one
 * column, and only for the caller's own row (session-scoped client,
 * "profiles: own update" RLS, never a client-supplied user id).
 */
export async function PATCH(request: NextRequest) {
  const rate = checkRateLimit(`profile:country:${getClientKey(request)}`, 20, 60_000)
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

  const parsed = countryUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  if (!isSupportedCountry(parsed.data.country_id)) {
    return NextResponse.json({ error: 'Unsupported country' }, { status: 400 })
  }

  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({ country_id: parsed.data.country_id })
    .eq('id', requester.userId)
    .select('country_id')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Could not update your country' }, { status: 500 })
  }

  const country = getCountry(data.country_id)
  return NextResponse.json({ country_id: country.id, display_name: country.name })
}
