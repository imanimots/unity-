import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, getLocale } from 'next-intl/server'
import { Navbar } from '@/components/shared/navbar'
import { AccountShell } from '@/components/account/account-shell'
import { redirect } from '@/i18n/navigation'
import { requireAuth } from '@/lib/supabase/require-admin'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { isRentToBuyEnabled } from '@/lib/rent-to-buy/config'

// Every authenticated dashboard route (renter/merchant/orders/barter/
// disputes/checkout/booking-transaction pages) is always noindex,
// regardless of the future SEO_INDEXING_ENABLED flag (Unity SEO
// Pre-Launch Hardening, Part E). robots.txt separately Disallows /dashboard/
// entirely (genuinely private, auth-gated infrastructure) — this meta
// directive is defense-in-depth for the case a URL is somehow reached
// despite that.
export const metadata: Metadata = { robots: PERMANENT_NOINDEX }

// Server-side authorization gate for every route under this group (renter
// dashboard, merchant dashboard, affiliate dashboard). This is the
// authoritative check — the proxy/middleware layer (src/lib/supabase/proxy.ts)
// also redirects unauthenticated requests before they reach here, but that's
// defense-in-depth, not the primary control. Mirrors src/app/admin/layout.tsx.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth()
  if (!auth) {
    const locale = await getLocale()
    redirect({ href: '/login', locale })
    return null
  }

  // Full message set, nested here rather than at the public root (same
  // principle as the merchant-only subtree's own provider, one level
  // deeper) -- this covers every authenticated dashboard route (renter,
  // merchant, barter, disputes, orders, checkout) with zero public-leak
  // concern, since nothing under (dashboard) is reachable anonymously or
  // indexed.
  const messages = await getMessages()
  const displayName = auth.profile.display_name ?? auth.profile.full_name ?? 'Unity member'
  return (
    <NextIntlClientProvider messages={messages}>
      <Navbar personalizationEnabled={isPersonalizationEnabled()} rentToBuyEnabled={isRentToBuyEnabled()} />
      <main className="pt-16 min-h-screen bg-[#FAF8F5]">
        <div className="pt-8">
          <AccountShell
            profile={{
              displayName,
              createdAt: auth.profile.created_at,
              initial: displayName[0]?.toUpperCase() ?? 'U',
            }}
            rentToBuyEnabled={isRentToBuyEnabled()}
            personalizationEnabled={isPersonalizationEnabled()}
            ambassadorUrl={process.env.NEXT_PUBLIC_WARP_AFFILIATE_URL}
          >
            {children}
          </AccountShell>
        </div>
      </main>
    </NextIntlClientProvider>
  )
}
