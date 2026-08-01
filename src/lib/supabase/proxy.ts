import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const SUPABASE_CONFIGURED =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_URL !== 'your_project_url_here' &&
  process.env.NEXT_PUBLIC_SUPABASE_URL.startsWith('http') &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

// Explicit opt-in only — see src/lib/mock/data.ts's IS_MOCK_MODE for the
// same convention. Kept as a separate constant (rather than importing from
// there) because this file runs in the Edge middleware runtime and should
// not pull in the mock data module's large in-memory fixtures.
const IS_MOCK_MODE = process.env.NEXT_PUBLIC_MOCK_MODE === 'true'

const PROTECTED_PATHS = ['/dashboard', '/admin']
const MERCHANT_ONLY_PATHS = ['/dashboard/merchant']

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Mock mode is an explicit, deliberate local-demo state — auth is
  // simulated client-side (see src/hooks/use-auth.ts), so there's no real
  // session cookie for middleware to check here. Let requests through,
  // matching how requireAdmin()/requireAuth() also bypass in mock mode.
  if (IS_MOCK_MODE) return NextResponse.next({ request })

  const isProtected = PROTECTED_PATHS.some((p) => pathname.startsWith(p))

  // Not mock mode, and Supabase isn't configured: there is no way to
  // authenticate anyone. Protected paths must deny by default rather than
  // silently letting requests through — the previous behavior here treated
  // "unconfigured" the same as "mock mode", which left dashboard/admin
  // routes wide open whenever real credentials simply hadn't been set yet.
  if (!SUPABASE_CONFIGURED) {
    if (isProtected) {
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      url.searchParams.set('redirectTo', pathname)
      return NextResponse.redirect(url)
    }
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (isProtected && !user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('redirectTo', pathname)
    return NextResponse.redirect(url)
  }

  // First line of defense for role-gated areas: reject before the route even
  // renders. This is not the only check — src/app/admin/layout.tsx and
  // src/app/(dashboard)/dashboard/merchant/layout.tsx re-verify server-side,
  // since middleware role checks can be skipped in edge runtimes or
  // misconfigured matchers and must not be the sole gate.
  const isMerchantOnly = MERCHANT_ONLY_PATHS.some((p) => pathname.startsWith(p))
  if (user && (pathname.startsWith('/admin') || isMerchantOnly)) {
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()

    if (pathname.startsWith('/admin') && profile?.role !== 'admin') {
      const url = request.nextUrl.clone()
      url.pathname = '/'
      return NextResponse.redirect(url)
    }

    if (isMerchantOnly && profile?.role !== 'merchant' && profile?.role !== 'both') {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard/renter'
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}
