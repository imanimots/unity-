'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { trackEvent } from '@/lib/analytics/client'
import { isExcludedFromPageViews } from '@/lib/analytics/validation'

/**
 * Mounted once, app-wide, in the public locale root layout (Section 18).
 * Emits exactly one `page_view` per real navigation to a new pathname --
 * keyed off `usePathname()` changing, never off a component re-render,
 * so React re-renders of the same page never produce duplicate events.
 * Never tracks /api/* or /admin/* as a consumer page view (defensive;
 * this component is not even mounted under /admin's own layout today).
 */
export function PageViewTracker() {
  const pathname = usePathname()
  const lastTrackedPath = useRef<string | null>(null)

  useEffect(() => {
    if (!pathname) return
    if (lastTrackedPath.current === pathname) return
    lastTrackedPath.current = pathname
    if (isExcludedFromPageViews(pathname)) return
    trackEvent('page_view')
  }, [pathname])

  return null
}
