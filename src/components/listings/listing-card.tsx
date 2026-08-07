'use client'

import Link from 'next/link'
import Image from 'next/image'
import { ShieldCheck, Star, MapPin, Heart } from 'lucide-react'
import type { Listing } from '@/types'
import { CATEGORIES } from '@/types'
import { deriveListingRatingDisplay } from '@/lib/listings/rating-display'

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
}

export function ListingCard({ listing, priority = false }: ListingCardProps) {
  const coverImage = listing.media?.[0]?.url
  const city = CITY_BY_MERCHANT[listing.merchant_id] ?? 'South Africa'
  const categoryLabel = CATEGORIES.find((c) => c.id === listing.category)?.label ?? listing.category
  // No genuine item-level review count exists in this schema yet (see
  // src/lib/listings/rating-display.ts) — never fabricate one.
  const rating = deriveListingRatingDisplay({ averageRating: null, reviewCount: 0 })

  return (
    <Link href={`/listings/${listing.id}`} className="group block">
      {/* Image */}
      <div className="relative aspect-[4/3] rounded-2xl overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] mb-3">
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

        {/* Badges */}
        <div className="absolute top-3 left-3 flex gap-1.5">
          {listing.ownership_verified && (
            <span className="inline-flex items-center gap-1 bg-white/95 dark:bg-[#1A1010]/95 backdrop-blur-sm rounded-full px-2 py-0.5 text-[11px] font-medium text-[#1A0A0A] dark:text-[#F5F0ED] shadow-sm">
              <ShieldCheck size={10} className="text-green-500" /> Verified
            </span>
          )}
          {listing.condition && (
            <span className="inline-flex items-center bg-white/95 dark:bg-[#1A1010]/95 backdrop-blur-sm rounded-full px-2 py-0.5 text-[11px] font-medium text-[#6B5B55] dark:text-[#9B8B85] shadow-sm">
              {CONDITION_LABEL[listing.condition]}
            </span>
          )}
        </div>

        {/* Wishlist */}
        <button
          onClick={(e) => e.preventDefault()}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/95 dark:bg-[#1A1010]/95 backdrop-blur-sm flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:scale-110"
          aria-label="Save to wishlist"
        >
          <Heart size={14} className="text-[#9B8B85] hover:text-red-500 transition-colors" />
        </button>
      </div>

      {/* Info */}
      <div className="space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] text-sm leading-snug line-clamp-2 group-hover:text-[#8B1A1A] transition-colors">
            {listing.title}
          </h3>
        </div>

        <div className="flex items-center gap-3 text-xs text-[#9B8B85]">
          <span className="flex items-center gap-1">
            <MapPin size={10} /> {city}
          </span>
          <span className="text-[#F2EDE8] dark:text-[#2A1A1A]">·</span>
          <span>{categoryLabel}</span>
        </div>

        <div className="flex items-center justify-between">
          {rating.show ? (
            <div className="flex items-center gap-1 text-xs text-[#9B8B85]">
              <Star size={11} className="text-amber-400 fill-amber-400" />
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{rating.score.toFixed(1)}</span>
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
  )
}
