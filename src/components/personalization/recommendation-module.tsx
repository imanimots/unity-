'use client'

import { useEffect, useState, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { ListingCard } from '@/components/listings/listing-card'
import { getAnonymousViews } from '@/lib/personalization/anonymous'
import type { Listing } from '@/types'
import type { RecommendationModule as ModuleName, RecommendationReasonCode } from '@/lib/personalization/types'
import { reasonMessageKey } from '@/lib/personalization/explanations'

interface Item {
  listing: Listing
  reasonCode: RecommendationReasonCode
  reasonContext: { category?: string; mode?: string; city?: string }
}

const MODULE_HEADING_KEY: Record<ModuleName, string> = {
  continue_browsing: 'personalization.modules.continueBrowsing',
  recommended_for_you: 'personalization.modules.recommendedForYou',
  because_you_viewed: 'personalization.modules.becauseYouViewed',
  near_your_area: 'personalization.modules.nearYourArea',
}

/**
 * Client-only "island" (Section 72): the surrounding page (homepage,
 * dashboard) stays static/server-rendered -- this component hydrates
 * independently and renders nothing at all if there's no meaningful
 * data (Section 30/56: never render an empty personalized section,
 * never fabricate recommendations from nothing).
 */
export function RecommendationModule({ module, isSignedIn }: { module: ModuleName; isSignedIn: boolean }) {
  const t = useTranslations()
  const tCategories = useTranslations('common.categories')
  const tMode = useTranslations('marketplace.mode')
  const [items, setItems] = useState<Item[] | null>(null)
  const tracked = useRef(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const body: Record<string, unknown> = { module, limit: 8 }
      if (!isSignedIn) {
        body.anonymousViews = getAnonymousViews().map((e) => ({
          entityType: e.entityType,
          entityId: e.entityId,
          mode: e.mode,
          category: e.category,
          kind: e.kind,
          province: e.province,
          city: e.city,
          viewCount: 1,
          lastViewedAt: e.viewedAt,
        }))
      }
      try {
        const res = await fetch('/api/personalization/recommendations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setItems(data.items ?? [])
      } catch {
        if (!cancelled) setItems([])
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [module, isSignedIn])

  useEffect(() => {
    if (!items || items.length === 0 || tracked.current) return
    tracked.current = true
    for (const [position, item] of items.entries()) {
      fetch('/api/personalization/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'impression',
          module,
          reasonCode: item.reasonCode,
          entityType: 'listing',
          entityId: item.listing.id,
          position,
        }),
      }).catch(() => {})
    }
  }, [items, module])

  if (!items || items.length === 0) return null

  return (
    <section className="py-12">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-16">
        <h2 className="section-heading text-[#1A0A0A] dark:text-[#F5F0ED] mb-6">{t(MODULE_HEADING_KEY[module])}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {items.map((item) => {
            const translatedContext: Record<string, string> = {}
            if (item.reasonContext.category) translatedContext.category = tCategories(item.reasonContext.category)
            if (item.reasonContext.mode) translatedContext.mode = tMode(item.reasonContext.mode as 'buy' | 'rent' | 'barter')
            if (item.reasonContext.city) translatedContext.city = item.reasonContext.city
            return (
              <div key={item.listing.id}>
                <ListingCard listing={item.listing} />
                <p className="text-xs text-[#9B8B85] mt-2">{t(reasonMessageKey(item.reasonCode), translatedContext)}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
