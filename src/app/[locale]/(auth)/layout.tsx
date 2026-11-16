import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { Navbar } from '@/components/shared/navbar'
import { Footer } from '@/components/shared/footer'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { isRentToBuyEnabled } from '@/lib/rent-to-buy/config'
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
  // namespace, which the root deliberately does not carry. `navigation` is
  // added here too (E47 Phase 8/9): auth pages now render the same shared
  // Navbar/Footer as every other public page, rather than a one-off
  // wordmark-only header with no footer at all.
  const messages = await getMessages()
  return (
    <NextIntlClientProvider messages={{ auth: messages.auth, navigation: messages.navigation }}>
      <Navbar personalizationEnabled={isPersonalizationEnabled()} rentToBuyEnabled={isRentToBuyEnabled()} />
      <main className="min-h-screen bg-[#FAF8F5] flex flex-col items-center px-4 pt-28 pb-16">
        {children}
      </main>
      <Footer />
    </NextIntlClientProvider>
  )
}
