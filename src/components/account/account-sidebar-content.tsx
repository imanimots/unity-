'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'
import type { Locale } from '@/i18n/locales'
import { formatDate } from '@/lib/i18n/format'
import {
  Home, Calendar, Store, Link2, Package, ShoppingBag, Repeat,
  MessageCircle, AlertTriangle, Wallet, User, CreditCard, ShieldCheck,
  Sparkles, ExternalLink, HelpCircle, Settings, LogOut, ChevronRight,
} from 'lucide-react'

export interface AccountSidebarProfile {
  displayName: string
  createdAt: string
  /** 'renter' | 'merchant' | 'both' | 'admin' -- only used for the
   * initials fallback here; role-specific visibility is intentionally
   * NOT applied (every signed-in user can see every dashboard entry
   * point today, matching the pre-E47 navbar's own behavior). */
  initial: string
}

interface AccountSidebarContentProps {
  profile: AccountSidebarProfile
  rentToBuyEnabled: boolean
  personalizationEnabled: boolean
  ambassadorUrl: string | undefined
  onNavigate?: () => void
  onSignOut: () => void
}

/**
 * The shared nav list rendered both in the persistent desktop sidebar
 * (Reference 05) and the mobile drawer -- one source of truth for the
 * authenticated account IA, per E47 Phase F/AD. Every link is a real,
 * existing route; "Overview" and "Saved items" from the reference IA
 * are deliberately not reproduced (no real page backs either one yet --
 * see the E47 report).
 */
export function AccountSidebarContent({
  profile, rentToBuyEnabled, personalizationEnabled, ambassadorUrl, onNavigate, onSignOut,
}: AccountSidebarContentProps) {
  const t = useTranslations('account.sidebar')
  const locale = useLocale() as Locale
  const pathname = usePathname()

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')

  const itemClass = (href: string) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
      isActive(href) ? 'bg-[#8B1A1A] text-white' : 'text-[#1A0A0A] hover:bg-[#F2EDE8]'
    }`
  const iconClass = (href: string) => (isActive(href) ? 'text-white' : 'text-[#9B8B85]')

  return (
    <div className="flex flex-col h-full">
      {/* Account header */}
      <Link
        href="/dashboard/profile"
        onClick={onNavigate}
        className="flex items-center gap-3 p-4 rounded-xl border border-[#F2EDE8] bg-white hover:border-[#8B1A1A]/30 transition-colors mb-6"
      >
        <div className="w-11 h-11 rounded-full bg-[#F2EDE8] flex items-center justify-center text-base font-bold text-[#1A0A0A] shrink-0">
          {profile.initial}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-[#1A0A0A] truncate">{profile.displayName}</p>
          <p className="text-xs text-[#9B8B85] truncate">{t('memberSince', { date: formatDate(profile.createdAt, locale) })}</p>
        </div>
        <ChevronRight size={16} className="text-[#9B8B85] shrink-0" />
      </Link>

      <nav className="flex-1 overflow-y-auto space-y-6">
        <div>
          <p className="section-label px-3 mb-2 text-[#9B8B85]">{t('dashboards')}</p>
          <div className="space-y-0.5">
            <Link href="/dashboard/renter" onClick={onNavigate} className={itemClass('/dashboard/renter')}>
              <Home size={16} className={iconClass('/dashboard/renter')} /> {t('renterDashboard')}
            </Link>
            <Link href="/dashboard/merchant" onClick={onNavigate} className={itemClass('/dashboard/merchant')}>
              <Store size={16} className={iconClass('/dashboard/merchant')} /> {t('merchantDashboard')}
            </Link>
            <Link href="/dashboard/affiliate" onClick={onNavigate} className={itemClass('/dashboard/affiliate')}>
              <Link2 size={16} className={iconClass('/dashboard/affiliate')} /> {t('affiliateDashboard')}
            </Link>
          </div>
        </div>

        <div>
          <p className="section-label px-3 mb-2 text-[#9B8B85]">{t('myActivity')}</p>
          <div className="space-y-0.5">
            <Link href="/dashboard/renter/bookings" onClick={onNavigate} className={itemClass('/dashboard/renter/bookings')}>
              <Calendar size={16} className={iconClass('/dashboard/renter/bookings')} /> {t('bookings')}
            </Link>
            <Link href="/dashboard/merchant/listings" onClick={onNavigate} className={itemClass('/dashboard/merchant/listings')}>
              <Package size={16} className={iconClass('/dashboard/merchant/listings')} /> {t('myListings')}
            </Link>
            <Link href="/dashboard/orders" onClick={onNavigate} className={itemClass('/dashboard/orders')}>
              <ShoppingBag size={16} className={iconClass('/dashboard/orders')} /> {t('myPurchases')}
            </Link>
            <Link href="/dashboard/merchant/orders" onClick={onNavigate} className={itemClass('/dashboard/merchant/orders')}>
              <Store size={16} className={iconClass('/dashboard/merchant/orders')} /> {t('mySales')}
            </Link>
            <Link href="/dashboard/barter" onClick={onNavigate} className={itemClass('/dashboard/barter')}>
              <Repeat size={16} className={iconClass('/dashboard/barter')} /> {t('trades')}
            </Link>
            {rentToBuyEnabled && (
              <Link href="/dashboard/rent-to-buy" onClick={onNavigate} className={itemClass('/dashboard/rent-to-buy')}>
                <Wallet size={16} className={iconClass('/dashboard/rent-to-buy')} /> {t('rentToBuy')}
              </Link>
            )}
            <Link href="/chat" onClick={onNavigate} className={itemClass('/chat')}>
              <MessageCircle size={16} className={iconClass('/chat')} /> {t('messages')}
            </Link>
            <Link href="/dashboard/disputes" onClick={onNavigate} className={itemClass('/dashboard/disputes')}>
              <AlertTriangle size={16} className={iconClass('/dashboard/disputes')} /> {t('disputes')}
            </Link>
          </div>
        </div>

        <div>
          <p className="section-label px-3 mb-2 text-[#9B8B85]">{t('account')}</p>
          <div className="space-y-0.5">
            <Link href="/dashboard/profile" onClick={onNavigate} className={itemClass('/dashboard/profile')}>
              <User size={16} className={iconClass('/dashboard/profile')} /> {t('myProfile')}
            </Link>
            <Link href="/dashboard/payout-settings" onClick={onNavigate} className={itemClass('/dashboard/payout-settings')}>
              <CreditCard size={16} className={iconClass('/dashboard/payout-settings')} /> {t('paymentsAndPayouts')}
            </Link>
            <Link href="/dashboard/privacy" onClick={onNavigate} className={itemClass('/dashboard/privacy')}>
              <ShieldCheck size={16} className={iconClass('/dashboard/privacy')} /> {t('privacy')}
            </Link>
            {personalizationEnabled && (
              <Link href="/dashboard/personalization" onClick={onNavigate} className={itemClass('/dashboard/personalization')}>
                <Sparkles size={16} className={iconClass('/dashboard/personalization')} /> {t('personalization')}
              </Link>
            )}
            <Link href="/dashboard/settings" onClick={onNavigate} className={itemClass('/dashboard/settings')}>
              <Settings size={16} className={iconClass('/dashboard/settings')} /> {t('settings')}
            </Link>
            {ambassadorUrl && (
              <a href={ambassadorUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-[#1A0A0A] hover:bg-[#F2EDE8] transition-colors">
                <ExternalLink size={16} className="text-[#9B8B85]" /> {t('ambassadorProgram')}
              </a>
            )}
            <Link href="/help" onClick={onNavigate} className={itemClass('/help')}>
              <HelpCircle size={16} className={iconClass('/help')} /> {t('help')}
            </Link>
          </div>
        </div>
      </nav>

      <div className="pt-4 mt-4 border-t border-[#F2EDE8]">
        <button
          onClick={onSignOut}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 hover:bg-[#FAF8F5] transition-colors"
        >
          <LogOut size={16} /> {t('signOut')}
        </button>
      </div>
    </div>
  )
}
