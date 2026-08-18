import { type NextRequest } from 'next/server'
import createIntlMiddleware from 'next-intl/middleware'
import { routing } from '@/i18n/routing'
import { updateSession } from '@/lib/supabase/proxy'

const intlMiddleware = createIntlMiddleware(routing)

// /api and /admin never carry a locale segment (admin stays English-only,
// api isn't user-navigated) -- next-intl's own routing never sees them, and
// updateSession() runs against the raw, unprefixed pathname exactly as
// before this phase, so their auth/session behavior is byte-for-byte
// unchanged.
const LOCALE_EXEMPT_PREFIXES = ['/api', '/admin']

// robots.txt/sitemap.xml (src/app/robots.ts, src/app/sitemap.ts) are
// special top-level metadata routes that live outside the [locale] segment
// entirely -- they are not pages next-intl's routing tree knows about, so
// running its middleware against them produces a rewrite to a nonexistent
// locale-prefixed path and a 404 (caught live via verify-seo-prelaunch-safety.mjs
// check 11 during this phase's own regression run). Exact-match only,
// deliberately not a prefix check -- these are single files, not subtrees.
const LOCALE_EXEMPT_EXACT_PATHS = ['/robots.txt', '/sitemap.xml']

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isLocaleExempt =
    LOCALE_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    LOCALE_EXEMPT_EXACT_PATHS.includes(pathname)

  if (isLocaleExempt) {
    return await updateSession(request)
  }

  const intlResponse = intlMiddleware(request)
  return await updateSession(request, intlResponse)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
