import Image from 'next/image'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Search, ListPlus, MessageCircle, ShieldCheck, ArrowRight, Package } from 'lucide-react'
import { getServerUser, MOCK_CURRENT_PROFILE } from '@/lib/data/profiles'
import { IS_MOCK_MODE, MOCK_RENTER_BOOKINGS } from '@/lib/mock/data'
import type { BookingStatus } from '@/types'
import { BOOKING_STATUS_LABELS, type BookingLifecycleStatus } from '@/lib/bookings/status-labels'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { RecommendationModule } from '@/components/personalization/recommendation-module'

const MOCK_STATUS_DOT: Record<BookingStatus, string> = {
  pending:   'bg-amber-400',
  approved:  'bg-blue-400',
  active:    'bg-green-400',
  returned:  'bg-[#9B8B85]',
  disputed:  'bg-red-400',
  cancelled: 'bg-[#9B8B85]',
}

// Real `bookings.status` uses the finer-grained lifecycle from
// lib/bookings/status-labels.ts, not the legacy mock-era BookingStatus
// union -- see the real bookings list page for the same mapping.
const REAL_STATUS_DOT: Record<BookingLifecycleStatus, string> = {
  requested: 'bg-amber-400',
  accepted: 'bg-blue-400',
  rejected: 'bg-[#9B8B85]',
  expired: 'bg-[#9B8B85]',
  cancelled_by_renter: 'bg-[#9B8B85]',
  cancelled_by_merchant: 'bg-[#9B8B85]',
  active: 'bg-green-400',
  return_pending: 'bg-amber-400',
  returned: 'bg-blue-400',
  completed: 'bg-[#9B8B85]',
  cancelled: 'bg-[#9B8B85]',
  disputed: 'bg-red-400',
}

const REAL_ACTIVE_STATUSES: BookingLifecycleStatus[] = ['accepted', 'active', 'return_pending']

interface DashboardBookingRow {
  id: string
  title: string
  cover: string | null
  statusDot: string
  statusLabel: string
}

export const metadata = { title: 'Renter Dashboard — Unity' }

export default async function RenterDashboard() {
  const t = await getTranslations('rent')
  const tCommon = await getTranslations('common')
  const MOCK_STATUS_LABEL: Record<BookingStatus, string> = {
    pending: t('status.pending'), approved: t('status.approved'), active: t('status.active'),
    returned: t('status.returned'), disputed: t('status.disputed'), cancelled: t('status.cancelled'),
  }
  const { profile: serverProfile } = await getServerUser()
  const profile = serverProfile ?? (IS_MOCK_MODE ? MOCK_CURRENT_PROFILE : null)
  const displayName = profile?.display_name ?? tCommon('dashboard.renterFallbackName')

  let totalBookingsCount = 0
  let activeBookingsCount = 0
  let activeRows: DashboardBookingRow[] = []

  if (IS_MOCK_MODE) {
    totalBookingsCount = MOCK_RENTER_BOOKINGS.length
    const active = MOCK_RENTER_BOOKINGS.filter((b) => b.status === 'active' || b.status === 'approved')
    activeBookingsCount = active.length
    activeRows = active.map((b) => ({
      id: b.id,
      title: b.listing.title,
      cover: b.listing.media?.[0]?.url ?? null,
      statusDot: MOCK_STATUS_DOT[b.status],
      statusLabel: MOCK_STATUS_LABEL[b.status],
    }))
  } else if (profile) {
    interface DashboardBookingQueryRow {
      id: string
      booking_reference: string | null
      status: BookingLifecycleStatus
    }
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    const { data } = supabase
      ? await supabase
          .from('bookings')
          .select('id, booking_reference, status')
          .eq('renter_id', profile.id)
          .order('created_at', { ascending: false })
      : { data: [] as DashboardBookingQueryRow[] }

    const bookings = (data ?? []) as DashboardBookingQueryRow[]
    totalBookingsCount = bookings.length
    const active = bookings.filter((b) => REAL_ACTIVE_STATUSES.includes(b.status))
    activeBookingsCount = active.length
    activeRows = active.slice(0, 5).map((b) => ({
      id: b.id,
      title: `${t('booking')} ${b.booking_reference ?? b.id.slice(-6).toUpperCase()}`,
      cover: null,
      statusDot: REAL_STATUS_DOT[b.status],
      statusLabel: BOOKING_STATUS_LABELS[b.status].label,
    }))
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Page heading */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{tCommon('dashboard.welcomeBack', { name: displayName })}</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] tracking-tight">
          {tCommon('dashboard.yourDashboard')}
        </h1>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-12">
        {/* Unity Score */}
        <div className="bg-white border border-[#F2EDE8] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{tCommon('dashboard.unityScore')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] leading-none">
            {profile?.unity_score?.toFixed(1) ?? '5.0'}
          </div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{tCommon('dashboard.outOfFive')}</p>
        </div>

        {/* Active bookings */}
        <div className="bg-white border border-[#F2EDE8] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{tCommon('dashboard.active')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] leading-none">
            {activeBookingsCount}
          </div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{tCommon('dashboard.rentalsLabel')}</p>
        </div>

        {/* Total bookings */}
        <div className="bg-white border border-[#F2EDE8] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{tCommon('dashboard.total')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] leading-none">
            {totalBookingsCount}
          </div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{tCommon('dashboard.bookingsLabel')}</p>
        </div>

        {/* KYC status */}
        <div className={`rounded-xl p-5 ${
          profile?.kyc_status === 'approved'
            ? 'bg-green-50 border border-green-200'
            : 'bg-amber-50 border border-amber-200'
        }`}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">{tCommon('dashboard.identity')}</p>
            <ShieldCheck size={14} className={profile?.kyc_status === 'approved' ? 'text-green-500' : 'text-amber-500'} />
          </div>
          {profile?.kyc_status === 'approved' ? (
            <>
              <div className="text-4xl lg:text-5xl font-extrabold text-green-700 leading-none">✓</div>
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{tCommon('verified')}</p>
            </>
          ) : (
            <>
              <div className="text-lg font-extrabold text-amber-700 leading-none mt-1">{tCommon('unverified')}</div>
              <Link href="/verify" className="text-[11px] font-medium uppercase tracking-[0.15em] text-amber-600 underline hover:no-underline mt-2 block">
                {tCommon('dashboard.completeKyc')}
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Your Bookings section */}
      <div className="mb-12">
        <div className="flex items-end justify-between mb-5">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">{tCommon('dashboard.yourBookingsLabel')}</p>
            <h2 className="text-lg font-extrabold uppercase text-[#1A0A0A] tracking-tight">{tCommon('dashboard.activeApprovedHeading')}</h2>
          </div>
          <Link href="/dashboard/renter/bookings" className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] hover:text-[#1A0A0A] flex items-center gap-1.5 transition-colors">
            {tCommon('dashboard.viewAll')}
          </Link>
        </div>

        <div className="bg-white border border-[#F2EDE8] rounded-xl">
          {activeRows.length === 0 ? (
            <div className="text-center py-16 px-8">
              <Package size={36} className="mx-auto text-[#9B8B85] mb-4" />
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{tCommon('dashboard.emptyActiveTitle')}</p>
              <p className="text-sm text-[#6B5B55] mb-6">{tCommon('dashboard.emptyActiveDesc')}</p>
              <Link href="/listings" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors">
                {tCommon('dashboard.browseItemsCta')} <ArrowRight size={14} />
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-[#F2EDE8]">
              {activeRows.map((b) => (
                <div key={b.id} className="flex items-center gap-4 px-5 py-4">
                  <div className="w-12 h-12 rounded-lg overflow-hidden bg-[#F2EDE8] shrink-0">
                    {b.cover ? (
                      <Image src={b.cover} alt={b.title} width={48} height={48} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-sm">📦</div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#1A0A0A] truncate mb-1">{b.title}</p>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-1.5 h-1.5 rounded-full ${b.statusDot}`} />
                      <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">{b.statusLabel}</span>
                    </div>
                  </div>
                  <Link href="/dashboard/renter/bookings" className="shrink-0 text-[#9B8B85] hover:text-[#1A0A0A] transition-colors">
                    <ArrowRight size={16} />
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Personalized discovery (Section 35) -- the (dashboard) layout
          already provides the full message tree client-side, so no
          extra scoped provider is needed here. */}
      {isPersonalizationEnabled() && (
        <div className="mb-12 -mx-4 sm:-mx-6 lg:-mx-8">
          <RecommendationModule module="continue_browsing" isSignedIn />
          <RecommendationModule module="recommended_for_you" isSignedIn />
        </div>
      )}

      {/* Quick actions */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-5">{tCommon('dashboard.quickActions')}</p>
        <div className="grid grid-cols-3 gap-3">
          {[
            { href: '/listings', icon: Search, label: tCommon('dashboard.browse'), desc: tCommon('dashboard.quickActionDescBrowse') },
            { href: '/looking-for/new', icon: ListPlus, label: tCommon('dashboard.lookingFor'), desc: tCommon('dashboard.quickActionDescLookingFor') },
            { href: '/chat', icon: MessageCircle, label: tCommon('dashboard.messages'), desc: tCommon('dashboard.quickActionDescMessages') },
          ].map(({ href, icon: Icon, label, desc }) => (
            <Link key={href} href={href}
              className="flex flex-col items-center gap-3 p-5 bg-white rounded-xl border border-[#F2EDE8] hover:bg-[#FAF8F5] transition-colors text-center group">
              <div className="w-10 h-10 rounded-xl bg-[#F2EDE8] flex items-center justify-center">
                <Icon size={18} className="text-[#8B1A1A]" />
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#1A0A0A]">{label}</div>
                <div className="text-xs text-[#9B8B85] mt-0.5 hidden sm:block">{desc}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
