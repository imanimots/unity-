'use client'

import { Suspense, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'

export type MarketplaceKind = 'item' | 'skill' | 'task'

/**
 * Only rendered by the caller when mode=barter -- Skills + Tasks under
 * Barter's browse integration (§36/D5). URL-driven, mirroring
 * DirectionToggleContainer's exact pattern: `kind` lives in the search
 * param, omitted entirely for the default 'item' so every non-barter
 * mode and item-under-barter behavior stays byte-for-byte unchanged.
 */
function KindToggleInner() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const kind = (searchParams.get('kind') as MarketplaceKind | null) ?? 'item'

  const handleChange = useCallback(
    (next: MarketplaceKind) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'item') params.delete('kind')
      else params.set('kind', next)
      params.delete('page')
      params.delete('cursor')
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  return (
    <div role="radiogroup" aria-label="Items, Skills, or Tasks" className="inline-flex rounded-full border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-1">
      {(['item', 'skill', 'task'] as const).map((id) => {
        const selected = kind === id
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => handleChange(id)}
            className={cn(
              'px-4 py-2 rounded-full text-sm font-semibold transition-colors',
              selected
                ? 'bg-[#8B1A1A] text-white'
                : 'text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]'
            )}
          >
            {id === 'item' ? 'Items' : id === 'skill' ? 'Skills' : 'Tasks'}
          </button>
        )
      })}
    </div>
  )
}

export function KindToggleContainer() {
  return (
    <Suspense fallback={null}>
      <KindToggleInner />
    </Suspense>
  )
}
