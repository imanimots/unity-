import { redirect } from 'next/navigation'
import { requireMerchant } from '@/lib/supabase/require-admin'

// Server-side authorization gate for merchant-only routes, layered inside
// the general dashboard auth gate (src/app/(dashboard)/layout.tsx — every
// route here is already known to be authenticated by the time this runs).
// This is the authoritative role check; src/lib/supabase/proxy.ts also
// rejects non-merchants before the request reaches here as defense-in-depth.
export default async function MerchantDashboardLayout({ children }: { children: React.ReactNode }) {
  const merchant = await requireMerchant()
  if (!merchant) redirect('/dashboard/renter')

  return <>{children}</>
}
