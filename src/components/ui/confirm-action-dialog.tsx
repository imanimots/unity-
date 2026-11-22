'use client'

import { AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/**
 * The one shared consequence-aware confirmation pattern for consequential
 * actions (see the customer-journey mapping's "no confirmation dialog
 * exists anywhere" finding -- cancel order/booking, decline, confirm
 * received, confirm return, confirm completion all previously fired
 * instantly or used a bare native window.prompt() with no consequence
 * copy). Modeled on this codebase's own best existing pattern for this
 * exact problem: RTB's "Initiate formal default" warning and the
 * payout-destination replace/disable warning modal.
 *
 * Never hardcodes a financial outcome -- `consequence` is passed in by
 * the caller, computed from the actual live transaction state, never
 * invented here.
 */

export interface ConfirmActionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Short action name, e.g. "Cancel this booking?" */
  title: string
  /** The actual consequence, derived from live state by the caller -- never a generic placeholder. */
  consequence: React.ReactNode
  /** Whether to show a free-text reason field. */
  reason?: {
    value: string
    onChange: (value: string) => void
    label: string
    placeholder?: string
    required?: boolean
  }
  confirmLabel: string
  cancelLabel?: string
  /** Destructive styling (red) vs. a neutral confirm (e.g. "Confirm completion" is consequential but not inherently negative). */
  destructive?: boolean
  submitting?: boolean
  error?: string | null
  onConfirm: () => void | Promise<void>
}

export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  consequence,
  reason,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = true,
  submitting = false,
  error,
  onConfirm,
}: ConfirmActionDialogProps) {
  const reasonMissing = Boolean(reason?.required) && !reason?.value.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {destructive && <AlertTriangle size={18} className="text-amber-600 shrink-0" />}
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm text-[#1A0A0A] leading-relaxed mb-4">{consequence}</div>

        {reason && (
          <div className="mb-2">
            <label htmlFor="confirm-action-reason" className="block text-sm font-medium text-[#1A0A0A] mb-1.5">
              {reason.label}
            </label>
            <textarea
              id="confirm-action-reason"
              rows={2}
              value={reason.value}
              onChange={(e) => reason.onChange(e.target.value)}
              placeholder={reason.placeholder}
              className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30"
            />
          </div>
        )}

        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="px-4 py-2 rounded-lg border border-[#E8E0D8] text-sm font-semibold text-[#6B5B55] hover:bg-[#FAF8F5] transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting || reasonMissing}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-50',
              destructive ? 'bg-[#8B1A1A] hover:bg-[#6B1414]' : 'bg-[#1A0A0A] hover:bg-black'
            )}
          >
            {submitting ? 'Please wait…' : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
