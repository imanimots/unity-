'use client'

import { useEffect } from 'react'
import { recordAnonymousView } from '@/lib/personalization/anonymous'
import type { PersonalizationKind, PersonalizationMode } from '@/lib/personalization/types'

interface RecordListingViewProps {
  personalizationEnabled: boolean
  isSignedIn: boolean
  listingId: string
  mode: PersonalizationMode | null
  category: string | null
  kind?: PersonalizationKind
  province: string | null
  city: string | null
}

/**
 * Records one "meaningful view" (Section 13) of a listing detail page.
 * A meaningful view is "the visitor actually opened this listing's own
 * page" -- not every render/re-render, and never on the browse/search
 * results grid itself. Anonymous visitors write straight to the local
 * buffer (no network call, no server-side anonymous identity);
 * signed-in visitors also post once to the server aggregate.
 */
export function RecordListingView(props: RecordListingViewProps) {
  useEffect(() => {
    if (!props.personalizationEnabled) return

    recordAnonymousView({
      entityType: 'listing',
      entityId: props.listingId,
      mode: props.mode,
      category: props.category,
      kind: props.kind ?? 'item',
      province: props.province,
      city: props.city,
    })

    if (props.isSignedIn) {
      fetch('/api/personalization/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType: 'listing',
          entityId: props.listingId,
          mode: props.mode,
          category: props.category,
          kind: props.kind ?? 'item',
          province: props.province,
          city: props.city,
        }),
      }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.listingId])

  return null
}
