'use client'

import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'
import { useState } from 'react'
import {
  Menu, X, Home, Search,
  MessageCircle, User, ChevronDown, LogOut,
  Package, Calendar, ExternalLink, Link2,
  ShoppingBag, Store, Repeat, AlertTriangle, Sparkles, Wallet, ShieldCheck,
  HelpCircle, Settings,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'

interface NavbarProps {
  /** Server-resolved PERSONALIZATION_ENABLED state (never
   * NEXT_PUBLIC_-derived -- see src/lib/personalization/config.ts).
   * Defaults false so this component never assumes the flag is on. */
  personalizationEnabled?: boolean
  /** Server-resolved RENT_TO_BUY_ENABLED state (see src/lib/rent-to-buy/
   * config.ts) -- mirrors personalizationEnabled's own prop shape.
   * Defaults false; only gates the nav LINK, never RTB data access
   * itself (an existing agreement page remains reachable by direct URL
   * either way, per Rule M). */
  rentToBuyEnabled?: boolean
}

export function Navbar({ personalizationEnabled = false, rentToBuyEnabled = false }: NavbarProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const { user, profile, signOut } = useAuth()
  const pathname = usePathname()
  const t = useTranslations('navigation')

  // E47: single, restrained public nav -- Home / Browse / How it works /
  // Chat / Help. Language, country, and dark-mode controls are removed
  // from here entirely (E47 Phase D/E): dark mode no longer exists, and
  // language/country now live in Account Settings for signed-in members
  // and in the footer for anonymous visitors (the one place CLAUDE.md's
  // binding "country selector in UI" requirement still applies to a
  // visitor with no account yet).
  const navLinks = [
    { href: '/', label: t('home') },
    { href: '/listings', label: t('browse') },
    { href: '/#how-it-works', label: t('howItWorks') },
    { href: '/chat', label: t('chat') },
    { href: '/help', label: t('help') },
  ]

  const isActive = (href: string) => pathname === href

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-sm border-b border-[#F2EDE8]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">

            {/* Logo — text only, no box */}
            <Link href="/" className="shrink-0">
              <span className="text-[#8B1A1A] font-extrabold text-xl tracking-tight">UNITY</span>
            </Link>

            {/* Desktop nav links — underline active state (matches the
                Help Centre reference) rather than a filled pill, kept
                consistent across every page for one coherent identity. */}
            <div className="hidden md:flex items-center gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                    isActive(link.href)
                      ? 'text-[#8B1A1A] after:absolute after:left-4 after:right-4 after:-bottom-[1px] after:h-[2px] after:bg-[#8B1A1A]'
                      : 'text-[#6B5B55] hover:text-[#1A0A0A]'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            {/* Right side */}
            <div className="flex items-center gap-2">

              {/* Auth: desktop — ONE primary CTA when signed out (Sign
                  Up); signed in replaces it with avatar + name, never both
                  Login and Sign Up side by side. */}
              {user ? (
                <div className="relative hidden md:block">
                  <button
                    onClick={() => setProfileOpen(!profileOpen)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[#F2EDE8] transition-colors"
                  >
                    <div className="w-7 h-7 rounded-full bg-[#F2EDE8] flex items-center justify-center text-xs font-semibold text-[#1A0A0A]">
                      {profile?.display_name?.[0]?.toUpperCase() ?? user.email?.[0]?.toUpperCase() ?? 'U'}
                    </div>
                    <span className="text-sm font-medium text-[#1A0A0A] max-w-[100px] truncate">
                      {profile?.display_name ?? user.email?.split('@')[0]}
                    </span>
                    <ChevronDown size={13} className="text-[#9B8B85]" />
                  </button>

                  {profileOpen && (
                    <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-lg border border-[#F2EDE8] py-1 z-50">
                      <Link href="/dashboard/profile" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <User size={14} className="text-[#9B8B85]" /> {t('myProfile')}
                      </Link>
                      <Link href="/dashboard/renter" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <Calendar size={14} className="text-[#9B8B85]" /> {t('bookings')}
                      </Link>
                      <Link href="/dashboard/merchant" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <Package size={14} className="text-[#9B8B85]" /> {t('myListings')}
                      </Link>
                      <Link href="/dashboard/orders" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <ShoppingBag size={14} className="text-[#9B8B85]" /> {t('myPurchases')}
                      </Link>
                      <Link href="/dashboard/merchant/orders" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <Store size={14} className="text-[#9B8B85]" /> {t('mySales')}
                      </Link>
                      <Link href="/dashboard/barter" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <Repeat size={14} className="text-[#9B8B85]" /> {t('myTrades')}
                      </Link>
                      {rentToBuyEnabled && (
                        <Link href="/dashboard/rent-to-buy" onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                          <Wallet size={14} className="text-[#9B8B85]" /> {t('rentToBuy')}
                        </Link>
                      )}
                      <Link href="/dashboard/disputes" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <AlertTriangle size={14} className="text-[#9B8B85]" /> {t('myDisputes')}
                      </Link>
                      <Link href="/dashboard/affiliate" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <Link2 size={14} className="text-[#9B8B85]" /> {t('affiliate')}
                      </Link>
                      {personalizationEnabled && (
                        <Link href="/dashboard/personalization" onClick={() => setProfileOpen(false)}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                          <Sparkles size={14} className="text-[#9B8B85]" /> {t('personalization')}
                        </Link>
                      )}
                      {process.env.NEXT_PUBLIC_WARP_AFFILIATE_URL && (
                        <a href={process.env.NEXT_PUBLIC_WARP_AFFILIATE_URL} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                          <ExternalLink size={14} className="text-[#9B8B85]" /> {t('ambassadorProgram')}
                        </a>
                      )}
                      <Link href="/dashboard/privacy" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <ShieldCheck size={14} className="text-[#9B8B85]" /> {t('privacy')}
                      </Link>
                      <Link href="/dashboard/settings" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <Settings size={14} className="text-[#9B8B85]" /> {t('settings')}
                      </Link>
                      <Link href="/help" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] hover:bg-[#FAF8F5] transition-colors">
                        <HelpCircle size={14} className="text-[#9B8B85]" /> {t('help')}
                      </Link>
                      <div className="border-t border-[#F2EDE8] mt-1 pt-1">
                        <button onClick={() => { setProfileOpen(false); signOut() }}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-[#FAF8F5] transition-colors">
                          <LogOut size={14} /> {t('signOut')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="hidden md:flex items-center">
                  <Link href="/register"
                    className="px-4 py-2 text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#7A1616] rounded-lg transition-colors">
                    {t('register')}
                  </Link>
                </div>
              )}

              {/* Mobile hamburger */}
              <button
                onClick={() => setMobileOpen(!mobileOpen)}
                className="md:hidden p-2 rounded-lg text-[#6B5B55] hover:bg-[#F2EDE8] transition-colors"
              >
                {mobileOpen ? <X size={19} /> : <Menu size={19} />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="md:hidden border-t border-[#F2EDE8] bg-white px-4 py-3 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`block px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive(link.href)
                    ? 'text-[#8B1A1A] bg-[#F2EDE8]'
                    : 'text-[#6B5B55] hover:bg-[#FAF8F5]'
                }`}
              >
                {link.label}
              </Link>
            ))}
            {user ? (
              <button
                onClick={() => { setMobileOpen(false); signOut() }}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 hover:bg-[#FAF8F5] mt-2 transition-colors"
              >
                {t('signOut')}
              </button>
            ) : (
              <div className="pt-2 space-y-2">
                <Link href="/register" onClick={() => setMobileOpen(false)}
                  className="block text-center px-4 py-2.5 text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#7A1616] rounded-lg transition-colors">
                  {t('register')}
                </Link>
                <Link href="/login" onClick={() => setMobileOpen(false)}
                  className="block text-center px-4 py-2 text-sm font-medium text-[#6B5B55]">
                  {t('alreadyHaveAccount')}
                </Link>
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-sm border-t border-[#F2EDE8]">
        <div className="grid grid-cols-4 h-16">
          {[
            { href: '/', icon: Home, label: t('home') },
            { href: '/listings', icon: Search, label: t('browse') },
            { href: '/chat', icon: MessageCircle, label: t('chat') },
            { href: user ? '/dashboard/renter' : '/login', icon: User, label: t('profile') },
          ].map(({ href, icon: Icon, label }) => (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                isActive(href) ? 'text-[#8B1A1A]' : 'text-[#9B8B85]'
              }`}
            >
              <Icon size={19} />
              <span className="text-[10px] font-medium uppercase tracking-[0.05em]">{label}</span>
            </Link>
          ))}
        </div>
      </div>

      {profileOpen && <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />}
    </>
  )
}
