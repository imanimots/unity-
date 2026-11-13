import { redirect } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getTranslations, getMessages, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { withLocalePrefix, type Locale } from '@/i18n/locales'
import { PayoutDestinationSettings } from '@/components/payouts/payout-destination-settings'

export async function generateMetadata() {
  const t = await getTranslations('common.payoutDestination')
  return { title: `${t('heading')} — Unity` }
}

/**
 * E34: one dedicated, role-agnostic settings page -- payout destination
 * authority is owner-keyed (profiles.id), not merchant/affiliate-keyed
 * (phase brief §11), so this is intentionally NOT nested under
 * /dashboard/merchant/ or /dashboard/affiliate/. Both dashboards link
 * here instead of each getting their own copy.
 */
export default async function PayoutSettingsPage() {
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix('/dashboard/payout-settings', locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const t = await getTranslations('common.payoutDestination')

  const messages = await getMessages()
  const scoped = { common: { payoutDestination: messages.common.payoutDestination } }

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
        <PayoutDestinationSettings />
      </NextIntlClientProvider>
    </div>
  )
}
