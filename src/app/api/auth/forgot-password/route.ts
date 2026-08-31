import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'
import { isLocale, withLocalePrefix, DEFAULT_LOCALE } from '@/i18n/locales'

/**
 * Always responds with the same generic shape regardless of whether the
 * email belongs to an account -- this route, not just Supabase's own
 * behavior, is the anti-enumeration boundary (Section 4 of the password
 * recovery remediation brief). Only a malformed request or a rate limit
 * gets a different response, neither of which discloses account state.
 */
const schema = z.object({
  email: z.string().email(),
  locale: z.string().optional(),
})

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

export async function POST(request: NextRequest) {
  const rate = checkRateLimit(`auth:forgot-password:${getClientKey(request)}`, 5, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests — please try again shortly' }, { status: 429 })
  }

  const body = await request.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a valid email' }, { status: 400 })
  }

  const locale = isLocale(parsed.data.locale) ? parsed.data.locale : DEFAULT_LOCALE
  const redirectTo = `${APP_URL}${withLocalePrefix('/reset-password', locale)}`

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Could not process this request right now' }, { status: 503 })
  }

  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo })

  if (error) {
    if (error.status === 429 || /rate limit/i.test(error.message)) {
      return NextResponse.json({ error: 'Too many requests — please try again shortly' }, { status: 429 })
    }
    // Any other error (e.g. transient network/provider failure) is logged
    // but never surfaced distinctly -- an account-existence-conditioned
    // error from Supabase must never produce a different response shape
    // than a genuine success, or the response itself becomes an
    // enumeration oracle.
    console.error('[auth.forgot-password] resetPasswordForEmail error', error.message)
  }

  return NextResponse.json({ ok: true })
}
