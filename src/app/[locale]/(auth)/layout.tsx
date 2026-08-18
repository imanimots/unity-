import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'

// Login/register/verify are always noindex, regardless of the future
// SEO_INDEXING_ENABLED flag (Unity SEO Pre-Launch Hardening, Part E) --
// these are public-but-low-value auth surfaces, never crawl-blocked
// (robots.txt still permits crawling them so this directive stays
// observable), just never worth a search result.
export const metadata: Metadata = { robots: PERMANENT_NOINDEX }

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Narrowly scoped nested provider (same principle as the root's public
  // message minimization, and the merchant-dashboard subtree's own nested
  // provider) -- login/register are 'use client' and need the `auth`
  // namespace, which the root deliberately does not carry. Scoped to just
  // this one namespace since these pages are anonymous/pre-authentication
  // and have no reason to receive anything broader.
  const messages = await getMessages()
  return (
    <NextIntlClientProvider messages={{ auth: messages.auth }}>
      <div className="min-h-screen bg-[#FAF8F5] flex flex-col">
        {/* Top wordmark */}
        <header className="flex justify-center px-6 pt-10 pb-4">
          <Link href="/" className="text-[#8B1A1A] font-extrabold text-2xl tracking-tight">
            UNITY
          </Link>
        </header>

        {/* Page content */}
        <main className="flex-1 flex flex-col items-center px-4 pt-8 pb-16">
          {children}
        </main>
      </div>
    </NextIntlClientProvider>
  )
}
