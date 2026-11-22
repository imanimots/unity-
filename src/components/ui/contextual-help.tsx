'use client'

import { Popover } from '@base-ui/react/popover'
import { Info, HelpCircle } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

/**
 * The one reusable contextual-help primitive for the whole app (see the
 * customer-journey mapping phase's "no tooltip/popover primitive exists
 * anywhere" finding). Built on @base-ui/react/popover -- already an
 * installed dependency (dialog.tsx wraps the same library) -- not a
 * hover-only tooltip, deliberately: a tooltip must never hold interactive
 * content per WAI-ARIA tooltip semantics, and this needs to hold an
 * optional "Learn more" link. A Popover's click/tap trigger also just is
 * mobile-usable by construction, where a hover tooltip would not be.
 *
 * Renders a small icon-only trigger with a required accessible label
 * (never an unlabeled icon button), a short explanation, and an optional
 * Help Centre link. Per the mapping's CRITICAL DISCLOSURE RULE, this is
 * for EXPLAINING a concept that is already visible elsewhere on the page
 * -- never for disclosing the existence of an amount, fee, or obligation
 * that isn't already shown in plain text next to it.
 */

export type ContextualHelpIcon = 'question' | 'info'

export interface ContextualHelpProps {
  /** Accessible label for the trigger button -- always required, never a bare icon with no name. */
  label: string
  /** The short explanation shown in the popup. Keep to 1-2 sentences -- this is the point-of-need version, not the full Help article. */
  children: React.ReactNode
  /** Optional popup heading, shown above the explanation. */
  title?: string
  /** Optional Help Centre route (e.g. "/help/what-verification-means") -- renders a "Learn more" link. */
  learnMoreHref?: string
  icon?: ContextualHelpIcon
  className?: string
}

export function ContextualHelp({ label, children, title, learnMoreHref, icon = 'question', className }: ContextualHelpProps) {
  const Icon = icon === 'info' ? Info : HelpCircle

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        className={cn(
          'inline-flex items-center justify-center w-4 h-4 rounded-full text-[#9B8B85] hover:text-[#8B1A1A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B1A1A]/50 transition-colors shrink-0 align-middle',
          className
        )}
      >
        <Icon size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} className="z-50">
          <Popover.Popup className="w-64 rounded-xl border border-[#F2EDE8] bg-white p-3.5 shadow-lg text-left data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 transition-opacity">
            {title && <p className="text-xs font-bold text-[#1A0A0A] mb-1">{title}</p>}
            <div className="text-xs text-[#6B5B55] leading-relaxed">{children}</div>
            {learnMoreHref && (
              <Link
                href={learnMoreHref}
                className="inline-block mt-2 text-xs font-semibold text-[#8B1A1A] hover:underline"
              >
                Learn more →
              </Link>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
