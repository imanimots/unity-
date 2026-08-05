'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

interface OpenDisputeDialogProps {
  transactionType: 'booking' | 'order' | 'barter'
  transactionId: string
  className?: string
  triggerLabel?: string
}

/**
 * The one shared "raise a dispute" entry point for all three transaction
 * types -- booking/order/barter actions components each render this
 * with their own transactionType/transactionId rather than three
 * near-duplicate dialogs.
 */
export function OpenDisputeDialog({ transactionType, transactionId, className, triggerLabel = 'Raise a dispute' }: OpenDisputeDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [requestedResolution, setRequestedResolution] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {
        title,
        description,
        requested_resolution: requestedResolution,
        idempotency_key: crypto.randomUUID(),
      }
      if (transactionType === 'booking') body.booking_id = transactionId
      else if (transactionType === 'order') body.order_id = transactionId
      else body.barter_agreement_id = transactionId

      const res = await fetch('/api/disputes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not open your dispute')
        return
      }
      setOpen(false)
      router.push(`/dashboard/disputes/${data.dispute_id}`)
    } catch {
      setError('Could not open your dispute — please try again')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          'flex items-center justify-center gap-2 w-full py-3 border border-[#8B1A1A] text-[#8B1A1A] font-semibold rounded-xl text-sm hover:bg-[#8B1A1A]/5 transition-colors'
        }
      >
        <AlertTriangle size={16} /> {triggerLabel}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Raise a dispute</DialogTitle>
            <DialogDescription>An admin will review this and reach out to both parties.</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="dispute-title" className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-1.5">
                Title
              </label>
              <input
                id="dispute-title"
                type="text"
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30"
                placeholder="A short summary of the issue"
              />
            </div>

            <div>
              <label htmlFor="dispute-description" className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-1.5">
                Description
              </label>
              <textarea
                id="dispute-description"
                required
                rows={4}
                maxLength={5000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30"
                placeholder="What happened?"
              />
            </div>

            <div>
              <label htmlFor="dispute-resolution" className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-1.5">
                What resolution are you looking for?
              </label>
              <textarea
                id="dispute-resolution"
                required
                rows={3}
                maxLength={2000}
                value={requestedResolution}
                onChange={(e) => setRequestedResolution(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30"
              />
            </div>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#6B1414] transition-colors disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : 'Submit dispute'}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
