'use client'

import { useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'

interface Props {
  agreementId: string
  amendmentId: string
}

/** Client-side accept/decline for a pending bilateral amendment proposal (Rule 21). */
export function AmendmentRespondButtons({ agreementId, amendmentId }: Props) {
  const router = useRouter()
  const t = useTranslations('rtb')
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const respond = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'decline')
    setError(null)
    try {
      const res = await fetch(`/api/rent-to-buy/agreements/${agreementId}/amendments/${amendmentId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? t('errors.generic'))
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex items-center gap-3 mt-2">
      {error && <p className="text-xs text-[#8B1A1A]">{error}</p>}
      <button disabled={busy !== null} onClick={() => respond(true)} className="text-xs font-semibold uppercase tracking-wide text-[#8B1A1A] disabled:opacity-50">
        {t('amendmentAccept')}
      </button>
      <button disabled={busy !== null} onClick={() => respond(false)} className="text-xs font-semibold uppercase tracking-wide text-[#6B5B55] dark:text-[#9B8B85] disabled:opacity-50">
        {t('amendmentDecline')}
      </button>
    </div>
  )
}
