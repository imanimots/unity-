'use client'

import { Suspense, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { MarketplaceModeSelector, type MarketplaceMode } from './MarketplaceModeSelector'

/**
 * URL-driven, matching FilterBar's category/sort/maxPrice pattern — mode
 * lives in the `mode` search param (omitted entirely for the default
 * 'rent', same convention FilterBar uses for its own defaults) so it
 * survives navigation/refresh and drives the server-rendered listing grid
 * on /listings, not just local component state.
 */
function MarketplaceModeSelectorInner() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const mode = (searchParams.get('mode') as MarketplaceMode | null) ?? 'rent'

  const handleChange = useCallback(
    (next: MarketplaceMode) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'rent') {
        params.delete('mode')
      } else {
        params.set('mode', next)
      }
      params.delete('page')
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  return <MarketplaceModeSelector selectedMode={mode} onChange={handleChange} />
}

export function MarketplaceModeSelectorContainer() {
  return (
    <Suspense fallback={null}>
      <MarketplaceModeSelectorInner />
    </Suspense>
  )
}
