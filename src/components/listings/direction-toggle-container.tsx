'use client'

import { Suspense, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'

export type MarketplaceDirection = 'available' | 'looking-for'

/**
 * URL-driven, mirroring MarketplaceModeSelectorContainer's exact
 * pattern (direction lives in the `direction` search param, omitted
 * for the default 'available' so it survives navigation/refresh and
 * drives the server-rendered grid on /listings, not just local state).
 * Preserves every other param (mode/q/category/sort/maxPrice) --
 * switching direction never accidentally switches transaction type.
 */
function DirectionToggleInner() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const direction = (searchParams.get('direction') as MarketplaceDirection | null) ?? 'available'

  const handleChange = useCallback(
    (next: MarketplaceDirection) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'available') params.delete('direction')
      else params.set('direction', next)
      params.delete('page')
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  return (
    <div role="radiogroup" aria-label="Available or Looking For" className="inline-flex rounded-full border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-1">
      {(['available', 'looking-for'] as const).map((id) => {
        const selected = direction === id
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => handleChange(id)}
            className={cn(
              'px-5 py-2 rounded-full text-sm font-semibold transition-colors',
              selected
                ? 'bg-[#8B1A1A] text-white'
                : 'text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]'
            )}
          >
            {id === 'available' ? 'Available' : 'Looking For'}
          </button>
        )
      })}
    </div>
  )
}

export function DirectionToggleContainer() {
  return (
    <Suspense fallback={null}>
      <DirectionToggleInner />
    </Suspense>
  )
}
