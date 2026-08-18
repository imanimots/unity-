import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getTranslations, getMessages, getLocale } from 'next-intl/server'
import { requireAuth } from '@/lib/supabase/require-admin'
import { RequestForm } from '@/components/marketplace/request-form'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'
import { withLocalePrefix, type Locale } from '@/i18n/locales'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('lookingFor.newRequestPage')
  return { title: t('metaTitle'), robots: PERMANENT_NOINDEX }
}

/** Requires sign-in to reach the form at all (publishing itself is additionally KYC-gated server-side in the RPC). Browsing requests never requires sign-in. */
export default async function NewLookingForRequestPage() {
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix('/looking-for/new', locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const t = await getTranslations('lookingFor.newRequestPage')

  // Narrowly scoped nested provider (same principle as the other public
  // book/buy/listing-detail/looking-for-detail pages) -- this page is
  // reachable only by authenticated users but lives under the (marketing)
  // layout, which has no wide provider by design. Scoped to just the
  // namespaces RequestForm and marketplace.mode actually need.
  const messages = await getMessages()
  const scoped = { lookingFor: { newRequestPage: messages.lookingFor.newRequestPage }, marketplace: { mode: messages.marketplace.mode } }

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen pt-24 pb-24 px-6 lg:px-12">
      <div className="max-w-[1400px] mx-auto">
        <p className="section-label mb-4">{t('sectionLabel')}</p>
        <h1 className="section-heading font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-10">
          {t('headingLine1')}<br className="hidden sm:block" /> {t('headingLine2')}
        </h1>
        <NextIntlClientProvider messages={scoped}>
          <RequestForm />
        </NextIntlClientProvider>
      </div>
    </div>
  )
}
