'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { COUNTRIES, DEFAULT_COUNTRY, STORAGE_KEY, getCountry, type Country } from '@/lib/countries'
import { useAuth } from '@/hooks/use-auth'

/** unity_country as a cookie too, not just localStorage -- Server Components can't read localStorage, so a cookie is what resolveEffectiveCountry() reads for anonymous users. A UX preference, not auth state, so a plain long-lived cookie is fine. */
function setCountryCookie(countryId: string) {
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${STORAGE_KEY}=${countryId}; path=/; max-age=31536000; SameSite=Lax${secure}`
}

export function CountrySelector() {
  // Lazy initializer, not a mount effect + setState -- server renders
  // DEFAULT_COUNTRY (window is undefined during SSR), client's first
  // render after hydration reads the real stored value directly. Same
  // established pattern already used for barter's mount-derived state
  // this session.
  const [selected, setSelected] = useState<Country>(() => {
    if (typeof window === 'undefined') return DEFAULT_COUNTRY
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? getCountry(stored) : DEFAULT_COUNTRY
  })
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { user } = useAuth()

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function select(country: Country) {
    const previous = selected
    setSelected(country)
    localStorage.setItem(STORAGE_KEY, country.id)
    setCountryCookie(country.id)
    setOpen(false)

    // Anonymous users: cookie + localStorage only, no profile call.
    if (!user) return

    try {
      const res = await fetch('/api/profile/country', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country_id: country.id }),
      })
      if (!res.ok) throw new Error('country update failed')
    } catch {
      // Recover cleanly -- roll the selection back rather than leaving the
      // UI showing a country that never actually persisted server-side.
      setSelected(previous)
      localStorage.setItem(STORAGE_KEY, previous.id)
      setCountryCookie(previous.id)
    }
  }

  const activeCountries = COUNTRIES.filter((c) => c.active)
  const comingSoon = COUNTRIES.filter((c) => !c.active)

  return (
    <div ref={ref} className="relative font-['Plus_Jakarta_Sans']">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
        aria-label="Select country"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="text-base leading-none">{selected.flag}</span>
        <span className="hidden sm:inline font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{selected.id}</span>
        <ChevronDown
          size={14}
          className={`text-[#6B5B55] dark:text-[#9B8B85] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full mt-1.5 w-52 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] shadow-lg overflow-hidden z-50"
        >
          {activeCountries.map((c) => (
            <button
              key={c.id}
              role="option"
              aria-selected={selected.id === c.id}
              onClick={() => select(c)}
              className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors text-left"
            >
              <span className="text-base">{c.flag}</span>
              <span className="flex-1">{c.name}</span>
              {selected.id === c.id && <Check size={14} className="text-[#8B1A1A]" />}
            </button>
          ))}

          {comingSoon.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-xs font-medium text-[#9B8B85] uppercase tracking-wide border-t border-[#F2EDE8] dark:border-[#2A1A1A] mt-0.5 pt-2">
                Coming soon
              </div>
              {comingSoon.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2.5 w-full px-3 py-2.5 text-sm text-[#9B8B85] cursor-default"
                >
                  <span className="text-base opacity-50">{c.flag}</span>
                  <span>{c.name}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
