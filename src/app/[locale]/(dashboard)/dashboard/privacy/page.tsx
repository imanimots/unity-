import { redirect } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getTranslations, getMessages, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { withLocalePrefix, type Locale } from '@/i18n/locales'
import { AccountErasureForm } from './account-erasure-form'

export async function generateMetadata() {
  const t = await getTranslations('privacy.erasure')
  return { title: `${t('heading')} — Unity` }
}

export default async function PrivacyPage() {
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix('/dashboard/privacy', locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const t = await getTranslations('privacy.erasure')

  // Narrow scoped provider, same pattern as the personalization settings
  // page -- the client form needs exactly privacy.erasure, never the full
  // dictionary tree.
  const messages = await getMessages()
  const scoped = { privacy: { erasure: messages.privacy.erasure } }

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
        <AccountErasureForm />
      </NextIntlClientProvider>
    </div>
  )
}
