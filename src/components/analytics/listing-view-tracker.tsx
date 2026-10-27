'use client'

import { useEffect, useRef } from 'react'
import { trackEvent } from '@/lib/analytics/client'

/**
 * D2-F1 remediation (ADMIN-CONTROL-CENTRE-BATCH-D2-F1): listing_viewed
 * moved out of the listing-detail Server Component's render body --
 * emitting it there made it a side effect of RSC function execution,
 * which Next.js prefetch, speculative rendering, and crawlers can all
 * trigger without a real visit. This client component only fires when
 * the browser actually mounts/hydrates the page for a genuine
 * navigation.
 *
 * Deduped on listingId: a rerender with the same id (React re-render,
 * Strict Mode's dev-mode double-effect-invoke) never re-fires; a fresh
 * mount for a DIFFERENT listing (new navigation) or a true page
 * refresh (ref resets to null) correctly fires again -- the latter is
 * a legitimate second view, not a duplicate.
 *
 * Classification (real/test/unknown) is never decided here -- only
 * entityType/entityId are sent; the ingestion route
 * (src/app/api/analytics/events/route.ts) looks up the real listing's
 * is_test column server-side, exactly as before this change.
 */
export function ListingViewTracker({ listingId, category }: { listingId: string; category?: string | null }) {
  const firedForListingId = useRef<string | null>(null)

  useEffect(() => {
    if (firedForListingId.current === listingId) return
    firedForListingId.current = listingId
    trackEvent('listing_viewed', { entityType: 'listing', entityId: listingId, metadata: category ? { category } : {} })
  }, [listingId, category])

  return null
}
