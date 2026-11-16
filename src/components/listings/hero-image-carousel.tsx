'use client'

import { useState } from 'react'
import Image from 'next/image'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface HeroImage {
  url: string
  alt: string
}

interface HeroImageCarouselProps {
  images: HeroImage[]
}

/**
 * Real listing photography, not stock/illustrative imagery (E47 Phase
 * AO) -- the parent page passes a handful of actual top-listing cover
 * images. Renders a single static image with no controls when there
 * are fewer than 2 (nothing to cycle through).
 */
export function HeroImageCarousel({ images }: HeroImageCarouselProps) {
  const [index, setIndex] = useState(0)
  if (images.length === 0) return null

  const go = (delta: 1 | -1) => setIndex((i) => (i + delta + images.length) % images.length)

  return (
    <div className="relative w-full h-full rounded-3xl overflow-hidden bg-[#F2EDE8]">
      {images.map((img, i) => (
        <Image
          key={img.url}
          src={img.url}
          alt={img.alt}
          fill
          priority={i === 0}
          className={`object-cover transition-opacity duration-500 ${i === index ? 'opacity-100' : 'opacity-0'}`}
          sizes="(max-width: 1024px) 0vw, 560px"
        />
      ))}

      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous image"
            className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center text-[#1A0A0A] shadow-sm hover:bg-white transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next image"
            className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 backdrop-blur-sm flex items-center justify-center text-[#1A0A0A] shadow-sm hover:bg-white transition-colors"
          >
            <ChevronRight size={16} />
          </button>
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
            {images.map((img, i) => (
              <button
                key={img.url}
                onClick={() => setIndex(i)}
                aria-label={`Go to image ${i + 1}`}
                className={`h-1.5 rounded-full transition-all ${i === index ? 'w-5 bg-white' : 'w-1.5 bg-white/60'}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
