import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * Thin themed wrapper over @base-ui/react/dialog, mirroring button.tsx's
 * pattern of wrapping a @base-ui/react primitive with Tailwind styling.
 * The barter Propose Trade / Counter-Offer flows are the first callers
 * (per the spec's explicit "Proposal modal" / "Counter-offer modal"
 * language) -- no Dialog/Modal component existed anywhere in
 * src/components/ui/ before this, despite the primitive already being an
 * installed dependency (admin's own slide-over panels are hand-rolled
 * per-page instead). Generic enough for any future modal need, not
 * barter-specific.
 */

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

function DialogPortal({ children, ...props }: DialogPrimitive.Portal.Props) {
  return (
    <DialogPrimitive.Portal {...props}>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
      {children}
    </DialogPrimitive.Portal>
  )
}

function DialogContent({ className, children, showClose = true, ...props }: DialogPrimitive.Popup.Props & { showClose?: boolean }) {
  return (
    <DialogPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <DialogPrimitive.Popup
          className={cn(
            'relative w-full max-h-[90vh] overflow-y-auto rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#0F0A0A] p-6 shadow-xl',
            'transition-all data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            className
          )}
          {...props}
        >
          {showClose && (
            <DialogClose className="absolute right-4 top-4 text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B1A1A] rounded-full p-1">
              <X size={18} />
              <span className="sr-only">Close</span>
            </DialogClose>
          )}
          {children}
        </DialogPrimitive.Popup>
      </div>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mb-4 space-y-1 pr-8', className)} {...props} />
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title className={cn('text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED]', className)} {...props} />
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description className={cn('text-sm text-[#6B5B55] dark:text-[#9B8B85]', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex items-center justify-end gap-3', className)} {...props} />
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter }
