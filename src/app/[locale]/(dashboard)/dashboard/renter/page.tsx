import Image from 'next/image'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Search, Heart, MessageCircle, Star, ShieldCheck, ArrowRight, Package, Camera } from 'lucide-react'
import { getServerUser, MOCK_CURRENT_PROFILE } from '@/lib/data/profiles'
import { IS_MOCK_MODE, MOCK_RENTER_BOOKINGS } from '@/lib/mock/data'
import type { BookingStatus } from '@/types'

const STATUS_DOT: Record<BookingStatus, string> = {
  pending:   'bg-amber-400',
  approved:  'bg-blue-400',
  active:    'bg-green-400',
  returned:  'bg-[#9B8B85]',
  disputed:  'bg-red-400',
  cancelled: 'bg-[#9B8B85]',
}

export const metadata = { title: 'Renter Dashboard — Unity' }

export default async function RenterDashboard() {
  const t = await getTranslations('rent')
  const tCommon = await getTranslations('common')
  const STATUS_LABEL: Record<BookingStatus, string> = {
    pending: t('status.pending'), approved: t('status.approved'), active: t('status.active'),
    returned: t('status.returned'), disputed: t('status.disputed'), cancelled: t('status.cancelled'),
  }
  const { profile: serverProfile } = await getServerUser()
  const profile = serverProfile ?? (IS_MOCK_MODE ? MOCK_CURRENT_PROFILE : null)
  const displayName = profile?.display_name ?? tCommon('dashboard.renterFallbackName')
  const myBookings = IS_MOCK_MODE ? MOCK_RENTER_BOOKINGS : []
  const activeBookings = myBookings.filter((b) => b.status === 'active' || b.status === 'approved')

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Page heading */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{tCommon('dashboard.welcomeBack', { name: displayName })}</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
          {tCommon('dashboard.yourDashboard')}
        </h1>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-12">
        {/* Unity Score */}
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{tCommon('dashboard.unityScore')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">
            {profile?.unity_score?.toFixed(1) ?? '5.0'}
          </div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{tCommon('dashboard.outOfFive')}</p>
        </div>

        {/* Active bookings */}
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{tCommon('dashboard.active')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">
            {activeBookings.length}
          </div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{tCommon('dashboard.rentalsLabel')}</p>
        </div>

        {/* Total bookings */}
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{tCommon('dashboard.total')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">
            {myBookings.length}
          </div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{tCommon('dashboard.bookingsLabel')}</p>
        </div>

        {/* KYC status */}
        <div className={`rounded-xl p-5 ${
          profile?.kyc_status === 'approved'
            ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
            : 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
        }`}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">{tCommon('dashboard.identity')}</p>
            <ShieldCheck size={14} className={profile?.kyc_status === 'approved' ? 'text-green-500' : 'text-amber-500'} />
          </div>
          {profile?.kyc_status === 'approved' ? (
            <>
              <div className="text-4xl lg:text-5xl font-extrabold text-green-700 dark:text-green-400 leading-none">✓</div>
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">{tCommon('verified')}</p>
            </>
          ) : (
            <>
              <div className="text-lg font-extrabold text-amber-700 dark:text-amber-400 leading-none mt-1">{tCommon('unverified')}</div>
              <Link href="/verify" className="text-[11px] font-medium uppercase tracking-[0.15em] text-amber-600 dark:text-amber-500 underline hover:no-underline mt-2 block">
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
            <h2 className="text-lg font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">{tCommon('dashboard.activeApprovedHeading')}</h2>
          </div>
          <Link href="/dashboard/renter/bookings" className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] flex items-center gap-1.5 transition-colors">
            {tCommon('dashboard.viewAll')}
          </Link>
        </div>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl">
          {activeBookings.length === 0 ? (
            <div className="text-center py-16 px-8">
              <Package size={36} className="mx-auto text-[#9B8B85] mb-4" />
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{tCommon('dashboard.emptyActiveTitle')}</p>
              <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">{tCommon('dashboard.emptyActiveDesc')}</p>
              <Link href="/listings" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors">
                {tCommon('dashboard.browseItemsCta')} <ArrowRight size={14} />
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-[#F2EDE8] dark:divide-[#2A1A1A]">
              {activeBookings.map((b) => {
                const cover = b.listing?.media?.[0]?.url
                const needsMedia = (b.status === 'approved' && !b.pre_rental_media_url) || (b.status === 'active' && !b.post_rental_media_url)
                return (
                  <div key={b.id} className="flex items-center gap-4 px-5 py-4">
                    <div className="w-12 h-12 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
                      {cover ? (
                        <Image src={cover} alt={b.listing.title} width={48} height={48} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-sm">📦</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] truncate mb-1">{b.listing.title}</p>
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[b.status]}`} />
                        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">{STATUS_LABEL[b.status]}</span>
                      </div>
                    </div>
                    {needsMedia && (
                      <Link href={`/dashboard/renter/bookings/${b.id}/media`} className="shrink-0 flex items-center gap-1.5 text-xs uppercase tracking-[0.08em] font-semibold px-3 py-1.5 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#7A1616] transition-colors">
                        <Camera size={11} /> {tCommon('dashboard.uploadCta')}
                      </Link>
                    )}
                    <Link href="/dashboard/renter/bookings" className="shrink-0 text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
                      <ArrowRight size={16} />
                    </Link>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-5">{tCommon('dashboard.quickActions')}</p>
        <div className="grid grid-cols-3 gap-3">
          {[
            { href: '/listings', icon: Search, label: tCommon('dashboard.browse'), desc: tCommon('dashboard.quickActionDescBrowse') },
            { href: '/dashboard/renter/wishlist', icon: Heart, label: tCommon('dashboard.wishlist'), desc: tCommon('dashboard.quickActionDescWishlist') },
            { href: '/chat', icon: MessageCircle, label: tCommon('dashboard.messages'), desc: tCommon('dashboard.quickActionDescMessages') },
          ].map(({ href, icon: Icon, label, desc }) => (
            <Link key={href} href={href}
              className="flex flex-col items-center gap-3 p-5 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors text-center group">
              <div className="w-10 h-10 rounded-xl bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center">
                <Icon size={18} className="text-[#8B1A1A]" />
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#1A0A0A] dark:text-[#F5F0ED]">{label}</div>
                <div className="text-xs text-[#9B8B85] mt-0.5 hidden sm:block">{desc}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
