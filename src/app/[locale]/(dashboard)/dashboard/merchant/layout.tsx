import { getLocale } from 'next-intl/server'
import { redirect } from '@/i18n/navigation'
import { requireMerchant } from '@/lib/supabase/require-admin'

// Server-side authorization gate for merchant-only routes, layered inside
// the general dashboard auth gate (src/app/(dashboard)/layout.tsx — every
// route here is already known to be authenticated by the time this runs).
// This is the authoritative role check; src/lib/supabase/proxy.ts also
// rejects non-merchants before the request reaches here as defense-in-depth.
//
// No nested NextIntlClientProvider needed here anymore: the parent
// (dashboard) layout now provides the full message set for the entire
// authenticated dashboard subtree (renter + merchant), so this file no
// longer needs its own -- kept only as the merchant-role gate.
export default async function MerchantDashboardLayout({ children }: { children: React.ReactNode }) {
  const merchant = await requireMerchant()
  if (!merchant) {
    const locale = await getLocale()
    redirect({ href: '/dashboard/renter', locale })
  }

  return <>{children}</>
}
