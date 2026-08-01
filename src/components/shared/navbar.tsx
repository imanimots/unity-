'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useState, useEffect } from 'react'
import {
  Sun, Moon, Menu, X, Home, Search,
  MessageCircle, User, ChevronDown, LogOut,
  Package, Calendar, ExternalLink, Link2,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { CountrySelector } from '@/components/shared/country-selector'

export function Navbar() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const { user, profile, signOut } = useAuth()
  const pathname = usePathname()

  useEffect(() => setMounted(true), [])

  const navLinks = [
    { href: '/', label: 'Home' },
    { href: '/listings', label: 'Browse' },
    { href: '/#how-it-works', label: 'How It Works' },
    { href: '/chat', label: 'Chat' },
  ]

  const isActive = (href: string) => pathname === href

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/95 dark:bg-[#0F0A0A]/95 backdrop-blur-sm border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">

            {/* Logo — text only, no box */}
            <Link href="/" className="shrink-0">
              <span className="text-[#8B1A1A] font-extrabold text-xl tracking-tight">UNITY</span>
            </Link>

            {/* Desktop nav links */}
            <div className="hidden md:flex items-center gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`px-4 py-2 text-sm font-medium uppercase tracking-[0.05em] transition-colors rounded-lg ${
                    isActive(link.href)
                      ? 'text-[#1A0A0A] dark:text-[#F5F0ED] bg-[#F2EDE8] dark:bg-[#2A1A1A]'
                      : 'text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010]'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            {/* Right side */}
            <div className="flex items-center gap-2">

              {/* Dark mode toggle */}
              {mounted && (
                <button
                  onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                  className="p-2 rounded-lg text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
                  aria-label="Toggle dark mode"
                >
                  {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
                </button>
              )}

              {/* Country selector */}
              <CountrySelector />

              {/* Auth: desktop */}
              {user ? (
                <div className="relative hidden md:block">
                  <button
                    onClick={() => setProfileOpen(!profileOpen)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
                  >
                    <div className="w-7 h-7 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center text-xs font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                      {profile?.display_name?.[0]?.toUpperCase() ?? user.email?.[0]?.toUpperCase() ?? 'U'}
                    </div>
                    <span className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] max-w-[100px] truncate">
                      {profile?.display_name ?? user.email?.split('@')[0]}
                    </span>
                    <ChevronDown size={13} className="text-[#9B8B85]" />
                  </button>

                  {profileOpen && (
                    <div className="absolute right-0 top-full mt-1.5 w-52 bg-white dark:bg-[#1A1010] rounded-xl shadow-lg border border-[#F2EDE8] dark:border-[#2A1A1A] py-1 z-50">
                      <Link href="/dashboard/renter" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
                        <Calendar size={14} className="text-[#9B8B85]" /> Bookings
                      </Link>
                      <Link href="/dashboard/merchant" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
                        <Package size={14} className="text-[#9B8B85]" /> My Listings
                      </Link>
                      <Link href="/dashboard/affiliate" onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
                        <Link2 size={14} className="text-[#9B8B85]" /> Affiliate
                      </Link>
                      {process.env.NEXT_PUBLIC_WARP_AFFILIATE_URL && (
                        <a href={process.env.NEXT_PUBLIC_WARP_AFFILIATE_URL} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
                          <ExternalLink size={14} className="text-[#9B8B85]" /> Ambassador Program
                        </a>
                      )}
                      <div className="border-t border-[#F2EDE8] dark:border-[#2A1A1A] mt-1 pt-1">
                        <button onClick={() => { setProfileOpen(false); signOut() }}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
                          <LogOut size={14} /> Sign out
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="hidden md:flex items-center gap-2">
                  <Link href="/login"
                    className="px-4 py-2 text-sm font-medium uppercase tracking-[0.05em] text-[#1A0A0A] dark:text-[#F5F0ED] border border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] rounded-lg transition-colors">
                    Log In
                  </Link>
                  <Link href="/register"
                    className="px-4 py-2 text-sm font-medium uppercase tracking-[0.05em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] rounded-lg transition-colors">
                    Sign Up
                  </Link>
                </div>
              )}

              {/* Mobile hamburger */}
              <button
                onClick={() => setMobileOpen(!mobileOpen)}
                className="md:hidden p-2 rounded-lg text-[#6B5B55] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
              >
                {mobileOpen ? <X size={19} /> : <Menu size={19} />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="md:hidden border-t border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#0F0A0A] px-4 py-3 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`block px-3 py-2.5 rounded-lg text-sm font-medium uppercase tracking-[0.05em] transition-colors ${
                  isActive(link.href)
                    ? 'text-[#1A0A0A] dark:text-[#F5F0ED] bg-[#F2EDE8] dark:bg-[#2A1A1A]'
                    : 'text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010]'
                }`}
              >
                {link.label}
              </Link>
            ))}
            {user ? (
              <button
                onClick={() => { setMobileOpen(false); signOut() }}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] mt-2 transition-colors"
              >
                Sign out
              </button>
            ) : (
              <div className="flex gap-2 pt-2">
                <Link href="/login" onClick={() => setMobileOpen(false)}
                  className="flex-1 text-center px-4 py-2.5 text-sm font-medium uppercase tracking-[0.05em] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors">
                  Log In
                </Link>
                <Link href="/register" onClick={() => setMobileOpen(false)}
                  className="flex-1 text-center px-4 py-2.5 text-sm font-medium uppercase tracking-[0.05em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] rounded-lg transition-colors">
                  Sign Up
                </Link>
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white/95 dark:bg-[#0F0A0A]/95 backdrop-blur-sm border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
        <div className="grid grid-cols-4 h-16">
          {[
            { href: '/', icon: Home, label: 'Home' },
            { href: '/listings', icon: Search, label: 'Browse' },
            { href: '/chat', icon: MessageCircle, label: 'Chat' },
            { href: user ? '/dashboard/renter' : '/login', icon: User, label: 'Profile' },
          ].map(({ href, icon: Icon, label }) => (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                isActive(href)
                  ? 'text-[#8B1A1A]'
                  : 'text-[#9B8B85] dark:text-[#6B5B55]'
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
