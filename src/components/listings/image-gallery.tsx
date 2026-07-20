'use client'

import { useState } from 'react'
import Image from 'next/image'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ListingMedia } from '@/types'

export function ImageGallery({ media, title }: { media: ListingMedia[]; title: string }) {
  const [active, setActive] = useState(0)

  if (!media.length) {
    return (
      <div className="aspect-[16/9] rounded-2xl bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center">
        <span className="text-6xl opacity-30">📦</span>
      </div>
    )
  }

  const prev = () => setActive((i) => (i === 0 ? media.length - 1 : i - 1))
  const next = () => setActive((i) => (i === media.length - 1 ? 0 : i + 1))

  return (
    <div className="space-y-3">
      {/* Main image */}
      <div className="relative aspect-[4/3] sm:aspect-[16/9] rounded-2xl overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] group">
        <Image
          src={media[active].url}
          alt={`${title} — photo ${active + 1}`}
          fill
          className="object-cover"
          sizes="(max-width: 1024px) 100vw, 60vw"
          priority
        />

        {media.length > 1 && (
          <>
            <button onClick={prev}
              className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 dark:bg-[#1A1010]/90 shadow-sm flex items-center justify-center text-[#1A0A0A] dark:text-[#F5F0ED] opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white dark:hover:bg-[#1A1010]">
              <ChevronLeft size={18} />
            </button>
            <button onClick={next}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 dark:bg-[#1A1010]/90 shadow-sm flex items-center justify-center text-[#1A0A0A] dark:text-[#F5F0ED] opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white dark:hover:bg-[#1A1010]">
              <ChevronRight size={18} />
            </button>
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
              {media.map((_, i) => (
                <button key={i} onClick={() => setActive(i)}
                  className={`h-1.5 rounded-full transition-all ${i === active ? 'bg-white w-4' : 'bg-white/50 w-1.5'}`} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Thumbnails */}
      {media.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {media.map((m, i) => (
            <button key={m.id} onClick={() => setActive(i)}
              className={`relative shrink-0 w-20 h-16 rounded-xl overflow-hidden border-2 transition-all ${
                i === active
                  ? 'border-[#8B1A1A]'
                  : 'border-[#F2EDE8] dark:border-[#2A1A1A] opacity-60 hover:opacity-100'
              }`}>
              <Image src={m.url} alt="" fill className="object-cover" sizes="80px" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
