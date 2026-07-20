'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { COUNTRIES, DEFAULT_COUNTRY, STORAGE_KEY, getCountry, type Country } from '@/lib/countries'

export function CountrySelector() {
  const [selected, setSelected] = useState<Country>(DEFAULT_COUNTRY)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) setSelected(getCountry(stored))
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function select(country: Country) {
    setSelected(country)
    localStorage.setItem(STORAGE_KEY, country.id)
    setOpen(false)
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
