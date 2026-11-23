'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ShieldCheck, Star, MapPin } from 'lucide-react'
import type { Listing } from '@/types'
import { CATEGORIES } from '@/types'
import { deriveListingRatingDisplay } from '@/lib/listings/rating-display'
import { ContextualHelp } from '@/components/ui/contextual-help'
import { CONTEXTUAL_COPY } from '@/lib/help/contextual-copy'

const CITY_BY_MERCHANT: Record<string, string> = {
  'user-1': 'Johannesburg',
  'user-2': 'Sandton',
  'user-3': 'Cape Town',
  'user-4': 'Durban',
}

const CONDITION_LABEL: Record<string, string> = {
  new: 'New',
  like_new: 'Like new',
  good: 'Good',
  fair: 'Fair',
}

interface ListingCardProps {
  listing: Listing
  priority?: boolean
  /**
   * Server-resolved translated "Verified" label -- passed in, not read via
   * useTranslations('common') here. This is the safe pattern for a public
   * Client Component: the parent Server Component only includes this prop
   * when `listing.ownership_verified` is actually true, so the word never
   * crosses the server/client boundary into a page's HTML for an
   * unverified listing. Passing it unconditionally (even to a component
   * that "wouldn't render" it) would still embed it in that page's RSC
   * payload for every listing -- the same underlying leak class the
   * NextIntlClientProvider dictionary-minimization fix addressed at the
   * namespace level; this fixes it at the individual-prop level for the
   * one remaining case that needed it.
   */
  verifiedLabel?: string
}

export function ListingCard({ listing, priority = false, verifiedLabel }: ListingCardProps) {
  const tAdvertising = useTranslations('advertising')
  const coverImage = listing.media?.[0]?.url
  const city = CITY_BY_MERCHANT[listing.merchant_id] ?? 'South Africa'
  const categoryLabel = CATEGORIES.find((c) => c.id === listing.category)?.label ?? listing.category
  // No genuine item-level review count exists in this schema yet (see
  // src/lib/listings/rating-display.ts) — never fabricate one.
  const rating = deriveListingRatingDisplay({ averageRating: null, reviewCount: 0 })

  // Advertising MVP: fire-and-forget click recording -- never blocks or
  // delays navigation. Clicks are analytics-only (never billable), so a
  // failed/slow beacon must never affect the user's click-through.
  const handleSponsoredClick = () => {
    if (!listing.sponsored || !listing.adCampaignId) return
    fetch('/api/advertising/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: listing.adCampaignId, impressionId: listing.adImpressionId }),
      keepalive: true,
    }).catch(() => {
      // Analytics-only -- a failed click beacon never blocks the user.
    })
  }

  return (
    <div className="relative group">
      <Link href={`/listings/${listing.id}`} className="block" onClick={handleSponsoredClick}>
        {/* Image */}
        <div className="relative aspect-[4/3] rounded-2xl overflow-hidden bg-[#F2EDE8] mb-3">
          {coverImage ? (
            <Image
              src={coverImage}
              alt={listing.title}
              fill
              className="object-cover transition-transform duration-500 group-hover:scale-105"
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
              priority={priority}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-5xl opacity-40">
                {CATEGORIES.find((c) => c.id === listing.category)?.icon ?? '📦'}
              </span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-extrabold text-[#1A0A0A] text-sm leading-snug line-clamp-2 group-hover:text-[#8B1A1A] transition-colors">
              {listing.title}
            </h3>
          </div>

          <div className="flex items-center gap-3 text-xs text-[#9B8B85]">
            <span className="flex items-center gap-1">
              <MapPin size={10} /> {city}
            </span>
            <span className="text-[#F2EDE8]">·</span>
            <span>{categoryLabel}</span>
          </div>

          <div className="flex items-center justify-between">
            {rating.show ? (
              <div className="flex items-center gap-1 text-xs text-[#9B8B85]">
                <Star size={11} className="text-amber-400 fill-amber-400" />
                <span className="font-medium text-[#1A0A0A]">{rating.score.toFixed(1)}</span>
                <span>({rating.reviewCount})</span>
              </div>
            ) : (
              <span />
            )}
            <div className="text-sm">
              <span className="font-extrabold text-[#8B1A1A]">R{listing.daily_rate}</span>
              <span className="text-[#9B8B85] text-xs"> /day</span>
            </div>
          </div>
        </div>
      </Link>

      {/* Badges — a sibling of the Link, not nested inside it: the
          Verified badge below holds an interactive ContextualHelp
          trigger, and a focusable control can't safely nest inside an
          <a> (see the toggle-container fix for the same constraint).
          pointer-events-none keeps every click that lands on plain badge
          text falling through to the card's Link underneath, exactly as
          before -- only the new help trigger itself opts back in. */}
      <div className="absolute top-3 left-3 flex gap-1.5 pointer-events-none">
        {listing.sponsored && (
          <span className="inline-flex items-center bg-[#1A0A0A]/90 backdrop-blur-sm rounded-full px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">
            {tAdvertising('sponsoredLabel')}
          </span>
        )}
        {listing.ownership_verified && verifiedLabel && (
          <span className="inline-flex items-center gap-1 bg-white/95 backdrop-blur-sm rounded-full px-2 py-0.5 text-[11px] font-medium text-[#1A0A0A] shadow-sm">
            <ShieldCheck size={10} className="text-green-500" /> {verifiedLabel}
            <ContextualHelp
              label={CONTEXTUAL_COPY.ownershipVerification.label}
              learnMoreHref={CONTEXTUAL_COPY.ownershipVerification.learnMoreHref}
              className="pointer-events-auto"
            >
              {CONTEXTUAL_COPY.ownershipVerification.text}
            </ContextualHelp>
          </span>
        )}
        {listing.condition && (
          <span className="inline-flex items-center bg-white/95 backdrop-blur-sm rounded-full px-2 py-0.5 text-[11px] font-medium text-[#6B5B55] shadow-sm">
            {CONDITION_LABEL[listing.condition]}
          </span>
        )}
      </div>
    </div>
  )
}
