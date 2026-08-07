import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { AdminShell } from './admin-shell'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'

// Always noindex, regardless of the future SEO_INDEXING_ENABLED flag
// (Unity SEO Pre-Launch Hardening, Part E). robots.txt separately
// Disallows /admin/ entirely — this is defense-in-depth.
export const metadata: Metadata = { robots: PERMANENT_NOINDEX }

// Server-side authorization gate. This is the authoritative check — the
// proxy/middleware layer (src/lib/supabase/proxy.ts) also rejects non-admins
// before the request reaches here, but that's defense-in-depth, not the
// primary control. Client-side checks (localStorage flags, hiding nav items)
// are never sufficient on their own since they can be bypassed from devtools.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin()
  if (!admin) redirect('/')

  return <AdminShell>{children}</AdminShell>
}
