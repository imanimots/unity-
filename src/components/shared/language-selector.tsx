'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronDown, Check, Languages } from 'lucide-react'
import { usePathname, useRouter } from '@/i18n/navigation'
import { LOCALES, LOCALE_DISPLAY_NAMES, type Locale } from '@/i18n/locales'
import { useAuth } from '@/hooks/use-auth'

/**
 * Mirrors CountrySelector's cookie + optional-profile-PATCH pattern exactly.
 * Switching language preserves the current logical destination (route +
 * query string) via next-intl's locale-aware router -- it never navigates
 * to the homepage. Anonymous users only get the cookie; authenticated users
 * also persist profiles.preferred_locale across devices.
 */
export function LanguageSelector() {
  const locale = useLocale() as Locale
  const t = useTranslations('navigation')
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function select(next: Locale) {
    setOpen(false)
    if (next === locale) return

    const query = searchParams.toString()
    const href = query ? `${pathname}?${query}` : pathname

    // next-intl's router computes the correctly prefixed URL (/, /af, /zu)
    // for the SAME logical route + query string -- this is what keeps a
    // user on "Rent / Electronics / Looking For" across a language switch
    // instead of resetting to the homepage.
    router.replace(href, { locale: next })

    // Anonymous users: cookie only, no profile call (next-intl's own
    // middleware/router already sets its locale cookie on navigation).
    if (!user) return

    try {
      await fetch('/api/profile/locale', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferred_locale: next }),
      })
    } catch {
      // Non-fatal: the page has already navigated to the requested locale
      // (URL is authoritative for this request either way, §71); a failed
      // profile PATCH only means the preference won't yet follow this user
      // to another device, not that anything visible broke.
    }
  }

  return (
    <div ref={ref} className="relative font-['Plus_Jakarta_Sans']">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
        aria-label={t('language')}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Languages size={15} />
        <span className="hidden sm:inline font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
          {LOCALE_DISPLAY_NAMES[locale]}
        </span>
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full mt-1.5 w-44 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] shadow-lg overflow-hidden z-50"
        >
          {LOCALES.map((l) => (
            <button
              key={l}
              role="option"
              aria-selected={locale === l}
              onClick={() => select(l)}
              className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors text-left"
            >
              <span className="flex-1">{LOCALE_DISPLAY_NAMES[l]}</span>
              {locale === l && <Check size={14} className="text-[#8B1A1A]" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
