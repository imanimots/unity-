'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useCallback, useState, Suspense } from 'react'
import { DayPicker, type DateRange } from 'react-day-picker'
import { SlidersHorizontal, X, MapPin, Calendar } from 'lucide-react'
import { CATEGORIES, SA_PROVINCES } from '@/types'
import { trackEvent } from '@/lib/analytics/client'
import { calendarDateToIsoDate } from '@/lib/search/date-filter'
import 'react-day-picker/style.css'

export type FilterBarEntity = 'listings' | 'requests' | 'skill_task'

/**
 * Per-entity sort matrix (Search Ranking MVP) -- each entity's ranking
 * RPC only supports the sort values it can actually honor in SQL:
 * listings get price sorts (they have a real price column), requests
 * get budget sorts (budget_min/budget_max), Skill/Task gets neither
 * (never monetary). 'Top Rated' was removed entirely -- no ranking RPC
 * has a genuine review-aware rating sort, and the previous client-side
 * "sort by raw unity_score" implementation defaulted unrated users to
 * 5.00, which is not a real signal worth exposing as a sort option.
 */
const SORT_OPTIONS_BY_ENTITY: Record<FilterBarEntity, { value: string; label: string }[]> = {
  listings: [
    { value: 'relevance', label: 'Relevance' },
    { value: 'price_asc', label: 'Price: Low to High' },
    { value: 'price_desc', label: 'Price: High to Low' },
    { value: 'newest', label: 'Newest' },
  ],
  requests: [
    { value: 'relevance', label: 'Relevance' },
    { value: 'budget_asc', label: 'Budget: Low to High' },
    { value: 'budget_desc', label: 'Budget: High to Low' },
    { value: 'newest', label: 'Newest' },
  ],
  skill_task: [
    { value: 'relevance', label: 'Relevance' },
    { value: 'newest', label: 'Newest' },
  ],
}

function FilterBarInner({ entity, trailingSlot }: { entity: FilterBarEntity; trailingSlot?: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const createURL = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value === null || value === '') {
        params.delete(key)
      } else {
        params.set(key, value)
      }
      params.delete('page')
      params.delete('cursor')
      return `${pathname}?${params.toString()}`
    },
    [pathname, searchParams]
  )

  /** Same as createURL but applies several key/value updates atomically -- needed for the date-range popover, which sets startDate+endDate together rather than one field at a time. */
  const createMultiURL = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') params.delete(key)
        else params.set(key, value)
      }
      params.delete('page')
      params.delete('cursor')
      return `${pathname}?${params.toString()}`
    },
    [pathname, searchParams]
  )

  const category = searchParams.get('category') ?? ''
  const sortOptions = SORT_OPTIONS_BY_ENTITY[entity]
  const rawSort = searchParams.get('sort') ?? ''
  const sort = sortOptions.some((o) => o.value === rawSort) ? rawSort : 'relevance'
  const maxPrice = searchParams.get('maxPrice') ?? ''
  const province = searchParams.get('province') ?? ''
  const city = searchParams.get('city') ?? ''
  const startDate = searchParams.get('startDate') ?? ''
  const endDate = searchParams.get('endDate') ?? ''
  const [cityDraft, setCityDraft] = useState(city)
  const [dateRangeOpen, setDateRangeOpen] = useState(false)
  const [pendingRange, setPendingRange] = useState<DateRange | undefined>(
    startDate && endDate ? { from: new Date(`${startDate}T00:00:00`), to: new Date(`${endDate}T00:00:00`) } : undefined
  )

  const activeFiltersCount = [category, maxPrice, province, city, startDate && endDate ? 'dates' : ''].filter(Boolean).length

  // search_refined (D2): fired on every genuine filter change (category,
  // max price, location, dates, or clearing filters), carrying the
  // resulting filter count -- not on the sort change alone, since sort
  // reorders the same result set rather than materially refining it.
  const refineAndNavigate = (url: string, nextFilters: { category: string; maxPrice: string; province: string; city: string; hasDateRange: boolean }) => {
    const filterCount = [nextFilters.category, nextFilters.maxPrice, nextFilters.province, nextFilters.city, nextFilters.hasDateRange ? 'dates' : '']
      .filter(Boolean).length
    trackEvent('search_refined', { metadata: { filter_count: filterCount } })
    router.push(url, { scroll: false })
  }

  const currentFilterState = { category, maxPrice, province, city, hasDateRange: Boolean(startDate && endDate) }

  return (
    <div className="space-y-4 w-full">
      {/* Category pills + trailing slot (Available/Looking For toggle,
          Kind toggle, post-a-request CTA) on one row -- matches the
          Browse reference's top filter row exactly. */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <button
            onClick={() => refineAndNavigate(createURL('category', null), { ...currentFilterState, category: '' })}
            className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              !category
                ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]'
                : 'border-[#F2EDE8] text-[#6B5B55] hover:border-[#8B1A1A] hover:text-[#8B1A1A]'
            }`}
          >
            All
          </button>
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => {
                const nextCategory = category === cat.id ? '' : cat.id
                refineAndNavigate(createURL('category', nextCategory || null), { ...currentFilterState, category: nextCategory })
              }}
              className={`shrink-0 flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                category === cat.id
                  ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]'
                  : 'border-[#F2EDE8] text-[#6B5B55] hover:border-[#8B1A1A] hover:text-[#8B1A1A]'
              }`}
            >
              <span>{cat.icon}</span>
              {cat.label.split(' ')[0]}
            </button>
          ))}
        </div>
        {trailingSlot}
      </div>

      {/* Max price + location + dates row -- location/dates only make
          sense for rentable listings, so scoped to entity === 'listings'
          exactly like max price already was. */}
      {entity === 'listings' && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={14} className="text-[#9B8B85]" />
            <span className="text-sm text-[#6B5B55]">Max price:</span>
            <select
              value={maxPrice}
              onChange={(e) => refineAndNavigate(createURL('maxPrice', e.target.value || null), { ...currentFilterState, maxPrice: e.target.value })}
              className="px-3 py-1.5 rounded-lg border border-[#F2EDE8] bg-white text-[#1A0A0A] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A] transition-colors"
            >
              <option value="">Any</option>
              <option value="100">Under R100/day</option>
              <option value="200">Under R200/day</option>
              <option value="300">Under R300/day</option>
              <option value="500">Under R500/day</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <MapPin size={14} className="text-[#9B8B85]" />
            <select
              value={province}
              onChange={(e) => refineAndNavigate(createURL('province', e.target.value || null), { ...currentFilterState, province: e.target.value })}
              className="px-3 py-1.5 rounded-lg border border-[#F2EDE8] bg-white text-[#1A0A0A] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A] transition-colors"
            >
              <option value="">Any province</option>
              {SA_PROVINCES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <input
              type="text"
              value={cityDraft}
              onChange={(e) => setCityDraft(e.target.value)}
              onBlur={() => {
                if (cityDraft !== city) refineAndNavigate(createURL('city', cityDraft || null), { ...currentFilterState, city: cityDraft })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && cityDraft !== city) {
                  refineAndNavigate(createURL('city', cityDraft || null), { ...currentFilterState, city: cityDraft })
                }
              }}
              placeholder="City"
              className="w-28 px-3 py-1.5 rounded-lg border border-[#F2EDE8] bg-white text-[#1A0A0A] text-sm placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:ring-[#8B1A1A] transition-colors"
            />
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setDateRangeOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                startDate && endDate
                  ? 'bg-[#8B1A1A]/5 border-[#8B1A1A] text-[#8B1A1A]'
                  : 'border-[#F2EDE8] text-[#6B5B55] hover:border-[#8B1A1A] hover:text-[#8B1A1A]'
              }`}
            >
              <Calendar size={14} />
              {startDate && endDate ? `${startDate} → ${endDate}` : 'Any dates'}
            </button>
            {dateRangeOpen && (
              <div className="absolute z-20 mt-2 bg-white rounded-2xl border border-[#F2EDE8] shadow-lg p-3">
                <DayPicker
                  mode="range"
                  selected={pendingRange}
                  onSelect={setPendingRange}
                  disabled={{ before: new Date() }}
                  numberOfMonths={1}
                  className="rdp-unity"
                />
                <div className="flex items-center justify-between gap-2 mt-2 px-1">
                  <button
                    type="button"
                    onClick={() => {
                      setPendingRange(undefined)
                      setDateRangeOpen(false)
                      refineAndNavigate(createMultiURL({ startDate: null, endDate: null }), { ...currentFilterState, hasDateRange: false })
                    }}
                    className="text-xs text-[#9B8B85] hover:text-[#8B1A1A]"
                  >
                    Clear dates
                  </button>
                  <button
                    type="button"
                    disabled={!pendingRange?.from || !pendingRange?.to}
                    onClick={() => {
                      if (!pendingRange?.from || !pendingRange?.to) return
                      const nextStart = calendarDateToIsoDate(pendingRange.from)
                      const nextEnd = calendarDateToIsoDate(pendingRange.to)
                      setDateRangeOpen(false)
                      refineAndNavigate(createMultiURL({ startDate: nextStart, endDate: nextEnd }), { ...currentFilterState, hasDateRange: true })
                    }}
                    className="px-3 py-1.5 rounded-lg bg-[#8B1A1A] text-white text-xs font-medium disabled:opacity-40"
                  >
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Clear filters + Sort row */}
      <div className="flex items-center justify-end gap-3 flex-wrap">
        {activeFiltersCount > 0 && (
          <button
            onClick={() => {
              setCityDraft('')
              setPendingRange(undefined)
              refineAndNavigate(pathname, { category: '', maxPrice: '', province: '', city: '', hasDateRange: false })
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-[#6B5B55] hover:text-[#8B1A1A] border border-[#F2EDE8] hover:border-[#8B1A1A] transition-colors"
          >
            <X size={12} /> Clear filters ({activeFiltersCount})
          </button>
        )}
        <div className="flex items-center gap-2">
          <span className="text-sm text-[#6B5B55]">Sort by:</span>
          <select
            value={sort}
            onChange={(e) => router.push(createURL('sort', e.target.value), { scroll: false })}
            className="px-3 py-2.5 rounded-xl border border-[#F2EDE8] bg-white text-[#1A0A0A] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A] transition-colors"
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}

export function FilterBar({ entity = 'listings', trailingSlot }: { entity?: FilterBarEntity; trailingSlot?: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="h-32 rounded-2xl bg-[#F2EDE8] animate-pulse" />}>
      <FilterBarInner entity={entity} trailingSlot={trailingSlot} />
    </Suspense>
  )
}
