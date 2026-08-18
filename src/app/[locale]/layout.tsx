import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { Toaster } from 'sonner'
import { AssistantWidgetLoader } from '@/components/assistant/assistant-widget-loader'
import { getAppUrl, getDefaultRobotsMeta } from '@/lib/seo/config'
import { routing } from '@/i18n/routing'
import { LOCALE_OG_TAGS, type Locale } from '@/i18n/locales'
import '../globals.css'

const plusJakarta = Plus_Jakarta_Sans({
  variable: '--font-plus-jakarta-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
})

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

// Locale-aware OpenGraph tag only for this phase — full metadata-text
// translation (title/description) is scoped as remaining work in the
// closure report, not silently skipped.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const ogLocale = hasLocale(routing.locales, locale) ? LOCALE_OG_TAGS[locale as Locale] : LOCALE_OG_TAGS['en-ZA']

  return {
    metadataBase: new URL(getAppUrl()),
    title: 'Unity — Rent What You Need. Earn From What You Have.',
    description: "South Africa's peer-to-peer rental marketplace. Identity-reviewed users, test-mode checkout.",
    robots: getDefaultRobotsMeta(),
    openGraph: {
      title: 'Unity — Rent What You Need.',
      description: "South Africa's peer-to-peer rental marketplace, currently in public test.",
      type: 'website',
      locale: ogLocale,
    },
    twitter: {
      card: 'summary_large_image',
    },
  }
}

export default async function LocaleRootLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()

  // Deliberately NOT the full message tree. A real bug this session's own
  // regression run caught: passing every namespace here embeds the whole
  // dictionary (including e.g. advertising.status.rejected = "Rejected")
  // into EVERY public page's HTML for client hydration -- a
  // clickable-profiles security check flagged this exact word appearing on
  // public profile pages as a potential KYC-state leak. Client Components
  // rendered on public pages today only need `common`/`navigation`
  // (navbar, footer's interactive bits, language-selector) plus the two
  // specific Advertising disclosure strings listing-card.tsx needs --
  // never the full `advertising` namespace (which carries campaign status
  // vocabulary that has no business being in public-page HTML). Anything
  // needing a broader namespace client-side lives behind its own nested
  // NextIntlClientProvider closer to where it's actually used (e.g.
  // src/app/[locale]/(dashboard)/dashboard/merchant/layout.tsx, an
  // authenticated + noindex subtree where that concern doesn't apply).
  // 'common' is deliberately excluded here: no currently-wired public
  // Client Component consumes it (confirmed via
  // `grep -rn "useTranslations('common')" src/` returning zero matches),
  // and several of its values (e.g. "Verified") are exactly the kind of
  // KYC-adjacent-sounding words the clickable-profiles security check
  // scans public profile pages for. Add it back deliberately, with the
  // same scrutiny applied to `advertising` below, only when a real public
  // client component needs a specific key from it.
  const messages = await getMessages()
  const publicClientMessages = {
    navigation: messages.navigation,
    advertising: {
      sponsoredLabel: (messages.advertising as Record<string, unknown>).sponsoredLabel,
      sponsoredSearchResult: (messages.advertising as Record<string, unknown>).sponsoredSearchResult,
    },
  }

  return (
    <html lang={locale} suppressHydrationWarning className={`${plusJakarta.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#FAF8F5] dark:bg-[#0F0A0A] text-[#1A0A0A] dark:text-[#F5F0ED]">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-[#8B1A1A] focus:text-white focus:text-sm focus:font-semibold"
        >
          Skip to main content
        </a>
        <NextIntlClientProvider messages={publicClientMessages}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            {children}
            <AssistantWidgetLoader />
            <Toaster position="top-center" richColors />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
