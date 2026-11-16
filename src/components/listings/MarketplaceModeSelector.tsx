'use client'

import { useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { ShoppingBag, Calendar, ArrowLeftRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export type MarketplaceMode = 'buy' | 'rent' | 'barter'

interface MarketplaceModeSelectorProps {
  selectedMode: MarketplaceMode
  onChange: (mode: MarketplaceMode) => void
  className?: string
}

const MODES: { id: MarketplaceMode; label: string; icon: typeof ShoppingBag }[] = [
  { id: 'buy', label: 'Buy', icon: ShoppingBag },
  { id: 'rent', label: 'Rent', icon: Calendar },
  { id: 'barter', label: 'Barter', icon: ArrowLeftRight },
]

/**
 * Presentational only — manages no routing/search/filter state itself.
 * The parent owns `selectedMode` and receives changes via `onChange`;
 * wiring this to real buy/rent/barter behavior later is just a matter
 * of doing something meaningful with that callback.
 */
export function MarketplaceModeSelector({ selectedMode, onChange, className }: MarketplaceModeSelectorProps) {
  const groupId = useId()
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  const focusAndSelect = (index: number) => {
    const wrapped = (index + MODES.length) % MODES.length
    buttonRefs.current[wrapped]?.focus()
    onChange(MODES[wrapped].id)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault()
        focusAndSelect(index + 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault()
        focusAndSelect(index - 1)
        break
      case 'Home':
        e.preventDefault()
        focusAndSelect(0)
        break
      case 'End':
        e.preventDefault()
        focusAndSelect(MODES.length - 1)
        break
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Marketplace mode"
      className={cn(
        // E45: bottom-20 on mobile clears the fixed bottom-nav bar
        // (src/components/shared/navbar.tsx, 0-64px, md:hidden) -- at
        // bottom-6 this selector's own 24-100px band overlapped it on
        // every viewport from 380px up to the md breakpoint. md:bottom-6
        // restores the original position once the bottom nav is gone.
        'fixed bottom-20 md:bottom-6 left-1/2 z-40 hidden -translate-x-1/2 min-[380px]:flex',
        'h-[76px] w-[92vw] max-w-[620px] items-center gap-1 rounded-full px-2.5',
        'border border-[#ECECEC] bg-white',
        'shadow-[0_12px_32px_-8px_rgba(26,10,10,0.18)],0,0,0.5)]',
        'transition-all duration-300',
        className
      )}
    >
      {MODES.map(({ id, label, icon: Icon }, index) => {
        const selected = selectedMode === id
        return (
          <button
            key={id}
            ref={(el) => {
              buttonRefs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            id={`${groupId}-${id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              'flex h-full flex-1 items-center justify-center gap-2 rounded-full text-sm font-semibold',
              'transition-all duration-300 ease-out',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B1A1A] focus-visible:ring-offset-2',
              selected
                ? 'scale-[1.02] bg-[#F2EDE8] text-[#1A0A0A] shadow-sm'
                : 'bg-transparent text-[#6B5B55] hover:bg-[#FAF8F5]'
            )}
          >
            <Icon size={18} strokeWidth={selected ? 2.25 : 1.75} />
            {label}
          </button>
        )
      })}
    </div>
  )
}
