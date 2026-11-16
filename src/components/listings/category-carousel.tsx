'use client'

import { useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { ListingCard } from '@/components/listings/listing-card'
import type { Listing } from '@/types'

interface CategoryCarouselProps {
  heading: string
  seeAllLabel: string
  seeAllHref: string
  listings: Listing[]
  verifiedLabel: string
  priority?: boolean
}

/**
 * One horizontally-scrolling category row (Browse/Homepage reference):
 * heading + "See all" on top, a scroll-snapped row of real ListingCards
 * below, arrow buttons + a dot indicator for the current page. Purely a
 * presentation wrapper around ListingCard -- no separate card style, so
 * Browse/Homepage/category rows never visually diverge from each other.
 */
export function CategoryCarousel({ heading, seeAllLabel, seeAllHref, listings, verifiedLabel, priority = false }: CategoryCarouselProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(0)
  const perPage = 4
  const pageCount = Math.ceil(listings.length / perPage)

  function scrollByPage(direction: 1 | -1) {
    const el = scrollerRef.current
    if (!el) return
    el.scrollBy({ left: direction * el.clientWidth, behavior: 'smooth' })
  }

  function handleScroll() {
    const el = scrollerRef.current
    if (!el || el.clientWidth === 0) return
    setPage(Math.round(el.scrollLeft / el.clientWidth))
  }

  return (
    <section className="mb-14">
      <div className="flex items-center justify-between gap-4 mb-5">
        <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] tracking-tight">{heading}</h2>
        <Link href={seeAllHref} className="shrink-0 inline-flex items-center gap-1.5 text-sm font-semibold text-[#8B1A1A] hover:underline">
          {seeAllLabel} <ChevronRight size={14} />
        </Link>
      </div>

      <div className="relative group/carousel">
        <div
          ref={scrollerRef}
          onScroll={handleScroll}
          className="flex gap-5 overflow-x-auto snap-x snap-mandatory scroll-smooth pb-1 scrollbar-hide"
        >
          {listings.map((listing, i) => (
            <div key={listing.id} className="shrink-0 snap-start w-[260px] sm:w-[270px]">
              <ListingCard
                listing={listing}
                priority={priority && i < 4}
                verifiedLabel={listing.ownership_verified ? verifiedLabel : undefined}
              />
            </div>
          ))}
        </div>

        {pageCount > 1 && (
          <>
            <button
              type="button"
              onClick={() => scrollByPage(-1)}
              aria-label="Scroll left"
              className="hidden sm:flex absolute left-0 top-[35%] -translate-y-1/2 -translate-x-1/2 w-9 h-9 rounded-full bg-white border border-[#F2EDE8] shadow-md items-center justify-center text-[#1A0A0A] opacity-0 group-hover/carousel:opacity-100 transition-opacity"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => scrollByPage(1)}
              aria-label="Scroll right"
              className="hidden sm:flex absolute right-0 top-[35%] -translate-y-1/2 translate-x-1/2 w-9 h-9 rounded-full bg-white border border-[#F2EDE8] shadow-md items-center justify-center text-[#1A0A0A] opacity-0 group-hover/carousel:opacity-100 transition-opacity"
            >
              <ChevronRight size={16} />
            </button>
          </>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center gap-1.5 mt-4">
          {Array.from({ length: pageCount }).map((_, i) => (
            <span key={i} className={`h-1 rounded-full transition-all ${i === page ? 'w-6 bg-[#8B1A1A]' : 'w-3 bg-[#F2EDE8]'}`} />
          ))}
        </div>
      )}
    </section>
  )
}
