'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useCallback, Suspense } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { CATEGORIES } from '@/types'

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

function FilterBarInner({ entity }: { entity: FilterBarEntity }) {
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

  const category = searchParams.get('category') ?? ''
  const sortOptions = SORT_OPTIONS_BY_ENTITY[entity]
  const rawSort = searchParams.get('sort') ?? ''
  const sort = sortOptions.some((o) => o.value === rawSort) ? rawSort : 'relevance'
  const maxPrice = searchParams.get('maxPrice') ?? ''

  const activeFiltersCount = [category, maxPrice].filter(Boolean).length

  return (
    <div className="space-y-4">
      {/* Sort row -- the query text itself is entered via the page's own
          hero search field (one search input, not two competing ones);
          this row only carries sort, which is entity-specific. */}
      <div className="flex justify-end">
        <select
          value={sort}
          onChange={(e) => router.push(createURL('sort', e.target.value), { scroll: false })}
          className="px-3 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A] transition-colors"
        >
          {sortOptions.map((o) => (
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
        {entity === 'listings' && (
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
        )}

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

export function FilterBar({ entity = 'listings' }: { entity?: FilterBarEntity }) {
  return (
    <Suspense fallback={<div className="h-32 rounded-2xl bg-[#F2EDE8] dark:bg-[#2A1A1A] animate-pulse" />}>
      <FilterBarInner entity={entity} />
    </Suspense>
  )
}
