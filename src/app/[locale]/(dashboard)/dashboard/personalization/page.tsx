import { redirect } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getTranslations, getMessages, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { withLocalePrefix, type Locale } from '@/i18n/locales'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { PersonalizationSettingsForm } from './personalization-settings-form'

export async function generateMetadata() {
  const t = await getTranslations('personalization.settings')
  return { title: `${t('heading')} — Unity` }
}

export default async function PersonalizationSettingsPage() {
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix('/dashboard/personalization', locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  // Personalization is a launch-gated feature (Section 63) -- when the
  // server flag is off, this page is simply not reachable, matching
  // "settings may be hidden or clearly unavailable" rather than
  // rendering a broken/empty settings form.
  if (!isPersonalizationEnabled()) {
    redirect(withLocalePrefix('/dashboard/renter', locale))
  }

  const t = await getTranslations('personalization.settings')

  // Narrow scoped provider (same principle used throughout this
  // codebase's public/client-boundary pages) -- the client form needs
  // exactly personalization.settings + common.categories, never the
  // full dictionary tree.
  const messages = await getMessages()
  const scoped = {
    personalization: { settings: messages.personalization.settings },
    common: { categories: messages.common.categories },
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
      <div className="mb-8">
        <Link href="/dashboard/renter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> {t('heading')}
        </Link>
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mt-4">{t('heading')}</h1>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-2 max-w-lg">{t('description')}</p>
      </div>
      <NextIntlClientProvider messages={scoped}>
        <PersonalizationSettingsForm />
      </NextIntlClientProvider>
    </div>
  )
}
