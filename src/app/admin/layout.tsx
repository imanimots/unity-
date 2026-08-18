import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { Toaster } from 'sonner'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { AdminShell } from './admin-shell'
import { getAppUrl, PERMANENT_NOINDEX } from '@/lib/seo/config'
import '../globals.css'

const plusJakarta = Plus_Jakarta_Sans({
  variable: '--font-plus-jakarta-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
})

// Always noindex, regardless of the future SEO_INDEXING_ENABLED flag
// (Unity SEO Pre-Launch Hardening, Part E). robots.txt separately
// Disallows /admin/ entirely — this is defense-in-depth.
export const metadata: Metadata = {
  metadataBase: new URL(getAppUrl()),
  robots: PERMANENT_NOINDEX,
}

// Admin stays English-only in this phase (binding i18n decision) and is
// excluded from the [locale] segment entirely — it is its own root layout
// (Next.js "multiple root layouts" pattern), not nested under
// src/app/[locale]/layout.tsx, so it owns <html>/<body> directly here.
//
// Server-side authorization gate. This is the authoritative check — the
// proxy/middleware layer (src/lib/supabase/proxy.ts) also rejects non-admins
// before the request reaches here, but that's defense-in-depth, not the
// primary control. Client-side checks (localStorage flags, hiding nav items)
// are never sufficient on their own since they can be bypassed from devtools.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin()
  if (!admin) redirect('/')

  return (
    <html lang="en-ZA" suppressHydrationWarning className={`${plusJakarta.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#FAF8F5] dark:bg-[#0F0A0A] text-[#1A0A0A] dark:text-[#F5F0ED]">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <Toaster position="top-center" richColors />
          <AdminShell>{children}</AdminShell>
        </ThemeProvider>
      </body>
    </html>
  )
}
