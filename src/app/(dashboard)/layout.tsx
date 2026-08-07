import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Navbar } from '@/components/shared/navbar'
import { requireAuth } from '@/lib/supabase/require-admin'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'

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
  if (!auth) redirect('/login')

  return (
    <>
      <Navbar />
      <main className="pt-16 min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">
        <div className="pt-8 pb-16">
          {children}
        </div>
      </main>
    </>
  )
}
