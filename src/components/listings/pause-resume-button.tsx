'use client'

import { useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { PauseCircle, PlayCircle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

interface Props {
  listingId: string
  status: 'active' | 'paused'
}

/**
 * Individual listing pause/resume -- available to every merchant
 * subscription tier (Rule: this is a basic lifecycle control, not a
 * paid entitlement). Calls the narrow single-listing routes
 * (POST /api/listings/[id]/pause|resume), never the Pro/Elite-gated
 * bulk route -- those reuse the identical merchant_pause_listing/
 * merchant_resume_listing RPCs, so ownership/state/cap authority is
 * unchanged either way; only the entitlement gate differs, and this
 * component's path has none.
 */
export function PauseResumeButton({ listingId, status }: Props) {
  const router = useRouter()
  const t = useTranslations('merchant.listingsPage')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function callAction(action: 'pause' | 'resume') {
    setBusy(true)
    try {
      const res = await fetch(`/api/listings/${listingId}/${action}`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(body.error ?? t('pauseResumeErrors.generic'))
        return
      }
      toast.success(action === 'pause' ? t('pauseResumeErrors.pausedSuccess') : t('pauseResumeErrors.resumedSuccess'))
      setConfirmOpen(false)
      router.refresh()
    } catch {
      toast.error(t('pauseResumeErrors.generic'))
    } finally {
      setBusy(false)
    }
  }

  if (status === 'active') {
    return (
      <>
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmOpen(true)}
          className="p-2 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20 text-[#9B8B85] hover:text-amber-600 dark:hover:text-amber-400 transition-colors disabled:opacity-50"
          title={t('pauseListingTitle')}
        >
          <PauseCircle size={16} />
        </button>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('pauseConfirmTitle')}</DialogTitle>
              <DialogDescription>{t('pauseConfirmDesc')}</DialogDescription>
            </DialogHeader>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => callAction('pause')}
                className="flex-1 py-2.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors disabled:opacity-50"
              >
                {busy ? t('pausing') : t('pauseListingTitle')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmOpen(false)}
                className="flex-1 py-2.5 border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold rounded-xl text-sm disabled:opacity-50"
              >
                {t('cancel')}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => callAction('resume')}
      className="p-2 rounded-lg hover:bg-green-50 dark:hover:bg-green-900/20 text-[#9B8B85] hover:text-green-600 dark:hover:text-green-400 transition-colors disabled:opacity-50"
      title={t('activateListingTitle')}
    >
      <PlayCircle size={16} />
    </button>
  )
}
