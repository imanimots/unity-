import type { Metadata } from 'next'
import { getTranslations, getLocale, getMessages } from 'next-intl/server'
import { NextIntlClientProvider } from 'next-intl'
import { redirect, Link } from '@/i18n/navigation'
import type { Locale } from '@/i18n/locales'
import { ShieldCheck, Mail, Phone, MapPin, Calendar, UserCircle2, ArrowRight } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { createClient } from '@/lib/supabase/server'
import { getActivitySummary } from '@/lib/profile/activity-summary'
import { getCountry } from '@/lib/countries'
import { formatDate } from '@/lib/i18n/format'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { PERMANENT_NOINDEX } from '@/lib/seo/config'
import { EditProfileButton } from './edit-profile-form'

export const metadata: Metadata = { title: 'My Profile — Unity', robots: PERMANENT_NOINDEX }

const ROLE_KEY: Record<string, 'accountTypeRenter' | 'accountTypeMerchant' | 'accountTypeBoth' | 'accountTypeAdmin'> = {
  renter: 'accountTypeRenter',
  merchant: 'accountTypeMerchant',
  both: 'accountTypeBoth',
  admin: 'accountTypeAdmin',
}

export default async function ProfilePage() {
  const auth = await requireAuth()
  const locale = (await getLocale()) as Locale
  if (!auth) {
    redirect({ href: '/login', locale })
    return null
  }

  const t = await getTranslations('account.profilePage')
  const supabase = await createClient()

  // Email + its real verification timestamp come from the auth user
  // record, not the profiles row -- requireAuth()/AuthedProfile doesn't
  // carry them, so they're fetched directly here (own session, read-only).
  const authUser = supabase ? (await supabase.auth.getUser()).data.user : null
  const emailVerified = Boolean(authUser?.email_confirmed_at)

  const activity = supabase
    ? await getActivitySummary(supabase, auth.userId)
    : { bookingsCount: 0, listingsCount: 0, tradesCount: 0 }

  const displayName = auth.profile.display_name ?? auth.profile.full_name ?? 'Unity member'
  const country = getCountry(auth.profile.country_id)
  const roleKey = ROLE_KEY[auth.profile.role] ?? 'accountTypeRenter'
  const identityVerified = auth.profile.kyc_status === 'approved'

  // Scoped nested provider for the one client component on this page
  // (Edit profile form), same leak-prevention pattern used throughout
  // this codebase's public pages.
  const messages = await getMessages()
  const scoped = { account: { profilePage: messages.account.profilePage } }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-extrabold text-[#1A0A0A] tracking-tight">{t('heading')}</h1>
          <p className="text-[#6B5B55] mt-1">{t('subheading')}</p>
        </div>
        <Link
          href="/dashboard/merchant/listings/new"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#8B1A1A] text-white text-sm font-semibold hover:bg-[#7A1616] transition-colors"
        >
          {t('listAnItem')} <ArrowRight size={15} />
        </Link>
      </div>

      {/* Identity card */}
      <div className="rounded-2xl border border-[#F2EDE8] bg-white p-6 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-[#F2EDE8] flex items-center justify-center text-xl font-bold text-[#1A0A0A] shrink-0">
              {displayName[0]?.toUpperCase() ?? 'U'}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-xl font-bold text-[#1A0A0A]">{displayName}</p>
                {identityVerified && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700">
                    <ShieldCheck size={12} /> {t('identityVerified')}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-sm text-[#6B5B55]">
                <span className="inline-flex items-center gap-1.5"><Mail size={13} /> {authUser?.email ?? '—'}</span>
                <span className="inline-flex items-center gap-1.5"><MapPin size={13} /> {country.name}</span>
              </div>
            </div>
          </div>
          <NextIntlClientProvider messages={scoped}>
            <EditProfileButton currentDisplayName={displayName} />
          </NextIntlClientProvider>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-6 pt-6 border-t border-[#F2EDE8]">
          <div>
            <p className="text-xs text-[#9B8B85] inline-flex items-center gap-1.5"><Calendar size={12} /> {t('memberSince')}</p>
            <p className="text-sm font-semibold text-[#1A0A0A] mt-1">{formatDate(auth.profile.created_at, locale)}</p>
          </div>
          <div>
            <p className="text-xs text-[#9B8B85] inline-flex items-center gap-1.5"><UserCircle2 size={12} /> {t('accountType')}</p>
            <p className="text-sm font-semibold text-[#1A0A0A] mt-1">{t(roleKey)}</p>
          </div>
          <div>
            <p className="text-xs text-[#9B8B85] inline-flex items-center gap-1.5"><Phone size={12} /> {t('phoneNumber')}</p>
            <p className="text-sm font-semibold text-[#1A0A0A] mt-1">{auth.profile.phone ?? t('notProvided')}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Trust & verification */}
        <div className="rounded-2xl border border-[#F2EDE8] bg-white p-6">
          <h2 className="font-bold text-[#1A0A0A]">{t('trustAndVerification')}</h2>
          <p className="text-sm text-[#6B5B55] mt-1 mb-4">{t('trustAndVerificationDesc')}</p>
          <ul className="space-y-3">
            <li className="flex items-center justify-between text-sm">
              <span className="text-[#1A0A0A]">{t('identityVerification')}</span>
              <StatusPill verified={identityVerified} pending={auth.profile.kyc_status === 'pending'} t={t} />
            </li>
            <li className="flex items-center justify-between text-sm">
              <span className="text-[#1A0A0A]">{t('emailAddress')}</span>
              <StatusPill verified={emailVerified} pending={false} t={t} />
            </li>
            <li className="flex items-center justify-between text-sm">
              <span className="text-[#1A0A0A]">{t('phoneNumber')}</span>
              <span className="text-xs font-medium text-[#9B8B85]">{auth.profile.phone ?? t('notProvided')}</span>
            </li>
          </ul>
          <Link href="/verify" className="inline-flex items-center gap-1.5 mt-5 text-sm font-semibold text-[#8B1A1A] hover:underline">
            {t('manageVerification')} <ArrowRight size={14} />
          </Link>
        </div>

        {/* Preferences */}
        <div className="rounded-2xl border border-[#F2EDE8] bg-white p-6">
          <h2 className="font-bold text-[#1A0A0A]">{t('preferences')}</h2>
          <p className="text-sm text-[#6B5B55] mt-1 mb-4">{t('preferencesDesc')}</p>
          <div className="space-y-1">
            {isPersonalizationEnabled() && (
              <Link href="/dashboard/personalization" className="flex items-center justify-between py-2.5 group">
                <div>
                  <p className="text-sm font-medium text-[#1A0A0A]">{t('notificationPreferences')}</p>
                  <p className="text-xs text-[#9B8B85]">{t('notificationPreferencesDesc')}</p>
                </div>
                <ArrowRight size={14} className="text-[#9B8B85] group-hover:text-[#8B1A1A] transition-colors" />
              </Link>
            )}
            <Link href="/dashboard/privacy" className="flex items-center justify-between py-2.5 group">
              <div>
                <p className="text-sm font-medium text-[#1A0A0A]">{t('privacySettings')}</p>
                <p className="text-xs text-[#9B8B85]">{t('privacySettingsDesc')}</p>
              </div>
              <ArrowRight size={14} className="text-[#9B8B85] group-hover:text-[#8B1A1A] transition-colors" />
            </Link>
          </div>
        </div>
      </div>

      {/* Activity */}
      <div className="rounded-2xl border border-[#F2EDE8] bg-white p-6 mt-6">
        <h2 className="font-bold text-[#1A0A0A]">{t('yourActivity')}</h2>
        <p className="text-sm text-[#6B5B55] mt-1 mb-5">{t('yourActivityDesc')}</p>
        <div className="grid grid-cols-3 gap-4">
          <ActivityStat value={activity.bookingsCount} label={t('bookingsLabel')} subtext={t('bookingsSubtext')} />
          <ActivityStat value={activity.listingsCount} label={t('listingsLabel')} subtext={t('listingsSubtext')} />
          <ActivityStat value={activity.tradesCount} label={t('tradesLabel')} subtext={t('tradesSubtext')} />
        </div>
      </div>
    </div>
  )
}

function StatusPill({ verified, pending, t }: { verified: boolean; pending: boolean; t: Awaited<ReturnType<typeof getTranslations<'account.profilePage'>>> }) {
  if (verified) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700"><ShieldCheck size={11} /> {t('verified')}</span>
  }
  if (pending) {
    return <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">{t('pending')}</span>
  }
  return <span className="rounded-full bg-[#F2EDE8] px-2.5 py-0.5 text-xs font-semibold text-[#6B5B55]">{t('notStarted')}</span>
}

function ActivityStat({ value, label, subtext }: { value: number; label: string; subtext: string }) {
  return (
    <div className="rounded-xl bg-[#FAF8F5] p-4">
      <p className="text-2xl font-extrabold text-[#1A0A0A]">{value}</p>
      <p className="text-sm font-semibold text-[#1A0A0A] mt-1">{label}</p>
      <p className="text-xs text-[#9B8B85]">{subtext}</p>
    </div>
  )
}
