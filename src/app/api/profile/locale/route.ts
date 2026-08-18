import { NextRequest, NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isLocale } from '@/i18n/locales'

/**
 * PATCH /api/profile/locale -- mirrors /api/profile/country exactly: one
 * narrow, single-purpose route for an authenticated user to change their
 * own persisted language preference. Writes exactly one column, only for
 * the caller's own row (session-scoped client, "profiles: own update" RLS,
 * never a client-supplied user id). The value is validated against the
 * fixed server-side locale allowlist (src/i18n/locales.ts), never trusted
 * as an arbitrary string -- the database CHECK constraint is the second,
 * authoritative layer of that same validation.
 */
export async function PATCH(request: NextRequest) {
  const rate = checkRateLimit(`profile:locale:${getClientKey(request)}`, 20, 60_000)
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

  const preferredLocale = (body as { preferred_locale?: unknown })?.preferred_locale
  if (typeof preferredLocale !== 'string' || !isLocale(preferredLocale)) {
    return NextResponse.json({ error: 'Unsupported locale' }, { status: 400 })
  }

  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({ preferred_locale: preferredLocale })
    .eq('id', requester.userId)
    .select('preferred_locale')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Could not update your language preference' }, { status: 500 })
  }

  return NextResponse.json({ preferred_locale: data.preferred_locale })
}
