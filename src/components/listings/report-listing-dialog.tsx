'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Flag } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

const REASON_VALUES = ['prohibited_item', 'misleading_listing', 'scam_fraud', 'counterfeit', 'inappropriate_content', 'other'] as const

/** Minimal listing-report mechanism (customer-journey P1 completion, batch 8) -- admin-only handling via /admin/listing-reports, no public visibility. Mirrors ReportProfileDialog exactly. */
export function ReportListingDialog({ listingId }: { listingId: string }) {
  const t = useTranslations('marketplace.detail.reportDialog')
  const tDetail = useTranslations('marketplace.detail')
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!reason) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/listings/${listingId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, description: description || undefined, idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('errors.couldNotSubmit'))
        return
      }
      setSubmitted(true)
    } catch {
      setError(t('errors.couldNotSubmitRetry'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs font-medium text-[#9B8B85] hover:text-[#8B1A1A] transition-colors"
      >
        <Flag size={12} /> {tDetail('report')}
      </button>

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setSubmitted(false); setReason(''); setDescription(''); setError(null) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>

          {submitted ? (
            <p className="text-sm text-[#6B5B55] py-4">{t('submitted')}</p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="listing-report-reason" className="block text-sm font-medium text-[#1A0A0A] mb-1.5">
                  {t('reasonLabel')}
                </label>
                <select
                  id="listing-report-reason"
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30"
                >
                  <option value="" disabled>{t('reasonPlaceholder')}</option>
                  {REASON_VALUES.map((r) => (
                    <option key={r} value={r}>{t(`reasons.${r}`)}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="listing-report-description" className="block text-sm font-medium text-[#1A0A0A] mb-1.5">
                  {t('descriptionLabel')}
                </label>
                <textarea
                  id="listing-report-description"
                  rows={3}
                  maxLength={1000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30"
                />
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={submitting || !reason}
                className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#6B1414] transition-colors disabled:opacity-50"
              >
                {submitting ? t('submitting') : t('submit')}
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
