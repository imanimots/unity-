import type { Metadata } from 'next'
import { getTranslations, getLocale } from 'next-intl/server'
import { redirect, Link } from '@/i18n/navigation'
import type { Locale } from '@/i18n/locales'
import { ArrowRight } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'
import { LanguageSelector } from '@/components/shared/language-selector'
import { CountrySelector } from '@/components/shared/country-selector'
import { ChangePasswordButton } from './change-password-button'

export const metadata: Metadata = { title: 'Settings — Unity', robots: PERMANENT_NOINDEX }

function SettingsRow({ title, desc, action }: { title: string; desc: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-5">
      <div className="max-w-md">
        <p className="font-semibold text-[#1A0A0A]">{title}</p>
        <p className="text-sm text-[#6B5B55] mt-0.5">{desc}</p>
      </div>
      {action}
    </div>
  )
}

export default async function SettingsPage() {
  const locale = (await getLocale()) as Locale
  const auth = await requireAuth()
  if (!auth) redirect({ href: '/login', locale })

  const t = await getTranslations('account.settingsPage')
  const supabase = await createClient()
  const authUser = supabase ? (await supabase.auth.getUser()).data.user : null

  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-extrabold text-[#1A0A0A] tracking-tight">{t('heading')}</h1>
      <p className="text-[#6B5B55] mt-1 mb-8">{t('subheading')}</p>

      <section className="rounded-2xl border border-[#F2EDE8] bg-white px-6 divide-y divide-[#F2EDE8]">
        <SettingsRow
          title={t('account')}
          desc={t('accountDesc')}
          action={
            <Link href="/dashboard/profile" className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#8B1A1A] hover:underline">
              {t('goToProfile')} <ArrowRight size={14} />
            </Link>
          }
        />

        {isPersonalizationEnabled() && (
          <SettingsRow
            title={t('notifications')}
            desc={t('notificationsDesc')}
            action={
              <Link href="/dashboard/personalization" className="px-4 py-2 rounded-lg border border-[#F2EDE8] text-sm font-semibold text-[#1A0A0A] hover:bg-[#F2EDE8] transition-colors">
                {t('manage')}
              </Link>
            }
          />
        )}

        <SettingsRow title={t('language')} desc={t('languageDesc')} action={<LanguageSelector />} />
        <SettingsRow title={t('country')} desc={t('countryDesc')} action={<CountrySelector />} />

        <SettingsRow
          title={t('privacy')}
          desc={t('privacyDesc')}
          action={
            <Link href="/dashboard/privacy" className="px-4 py-2 rounded-lg border border-[#F2EDE8] text-sm font-semibold text-[#1A0A0A] hover:bg-[#F2EDE8] transition-colors">
              {t('manage')}
            </Link>
          }
        />

        <SettingsRow
          title={t('security')}
          desc={t('securityDesc')}
          action={<ChangePasswordButton email={authUser?.email ?? null} />}
        />
      </section>
    </div>
  )
}
