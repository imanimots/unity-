'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useCallback, Suspense } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { CATEGORIES } from '@/types'

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'price_asc', label: 'Price: Low to High' },
  { value: 'price_desc', label: 'Price: High to Low' },
  { value: 'newest', label: 'Newest' },
  { value: 'rating', label: 'Top Rated' },
]

function FilterBarInner() {
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
      return `${pathname}?${params.toString()}`
    },
    [pathname, searchParams]
  )

  const category = searchParams.get('category') ?? ''
  const sort = searchParams.get('sort') ?? 'relevance'
  const query = searchParams.get('q') ?? ''
  const maxPrice = searchParams.get('maxPrice') ?? ''

  const activeFiltersCount = [category, maxPrice].filter(Boolean).length

  return (
    <div className="space-y-4">
      {/* Search row */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input
            type="text"
            placeholder="Search listings..."
            defaultValue={query}
            onChange={(e) => {
              const url = createURL('q', e.target.value || null)
              router.push(url, { scroll: false })
            }}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] placeholder-[#9B8B85] focus:outline-none focus:ring-2 focus:ring-[#8B1A1A] text-sm transition-colors"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => router.push(createURL('sort', e.target.value), { scroll: false })}
          className="px-3 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A] transition-colors"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Category pills */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide">
        <button
          onClick={() => router.push(createURL('category', null), { scroll: false })}
          className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
            !category
              ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]'
              : 'border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:border-[#8B1A1A] hover:text-[#8B1A1A]'
          }`}
        >
          All
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() =>
              router.push(
                createURL('category', category === cat.id ? null : cat.id),
                { scroll: false }
              )
            }
            className={`shrink-0 flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              category === cat.id
                ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]'
                : 'border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:border-[#8B1A1A] hover:text-[#8B1A1A]'
            }`}
          >
            <span>{cat.icon}</span>
            {cat.label.split(' ')[0]}
          </button>
        ))}
      </div>

      {/* Price + active filters row */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={14} className="text-[#9B8B85]" />
          <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">Max price:</span>
          <select
            value={maxPrice}
            onChange={(e) => router.push(createURL('maxPrice', e.target.value || null), { scroll: false })}
            className="px-3 py-1.5 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A] transition-colors"
          >
            <option value="">Any</option>
            <option value="100">Under R100/day</option>
            <option value="200">Under R200/day</option>
            <option value="300">Under R300/day</option>
            <option value="500">Under R500/day</option>
          </select>
        </div>

        {activeFiltersCount > 0 && (
          <button
            onClick={() => router.push(pathname, { scroll: false })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#8B1A1A] border border-[#F2EDE8] dark:border-[#2A1A1A] hover:border-[#8B1A1A] transition-colors"
          >
            <X size={12} /> Clear filters ({activeFiltersCount})
          </button>
        )}
      </div>
    </div>
  )
}

export function FilterBar() {
  return (
    <Suspense fallback={<div className="h-32 rounded-2xl bg-[#F2EDE8] dark:bg-[#2A1A1A] animate-pulse" />}>
      <FilterBarInner />
    </Suspense>
  )
}
