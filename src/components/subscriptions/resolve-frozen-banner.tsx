'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import type { MerchantPublicationSummary } from '@/app/api/subscriptions/me/publications/route'

interface ResolveFrozenBannerProps {
  publicationLimit: number | null
  onResolved: () => void
}

/**
 * Section 21-22: shown instead of ANY auto-selection. A downgrade took
 * effect but the merchant's keep-set was missing/invalid at that
 * moment -- publishing/reactivating is frozen platform-wide (server-
 * enforced, not just this banner) until the merchant makes this choice
 * themselves, right now.
 */
export function ResolveFrozenBanner({ publicationLimit, onResolved }: ResolveFrozenBannerProps) {
  const t = useTranslations('merchant.subscriptionPage.resolveFrozen')
  const [publications, setPublications] = useState<MerchantPublicationSummary[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/subscriptions/me/publications')
    if (res.ok) setPublications((await res.json()).items)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (publicationLimit === null || next.size < publicationLimit) next.add(id)
      return next
    })
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/subscriptions/resolve-frozen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entities: publications?.filter((p) => selected.has(p.entityId)).map((p) => ({ entityType: p.entityType, entityId: p.entityId })) ?? [],
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const result = await res.json()
      if (!res.ok) {
        setError(result.error ?? t('genericError'))
        return
      }
      onResolved()
    } catch {
      setError(t('genericError'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-800 rounded-xl p-6 mb-6">
      <div className="flex items-start gap-3 mb-4">
        <AlertTriangle size={18} className="text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">{t('title')}</p>
          <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">{t('description', { limit: publicationLimit ?? 0 })}</p>
        </div>
      </div>

      {publications && (
        <>
          <ul className="space-y-2 mb-4 max-h-64 overflow-y-auto">
            {publications.map((pub) => (
              <li key={pub.entityId} className="flex items-start gap-2">
                <input type="checkbox" id={`resolve-keep-${pub.entityId}`} checked={selected.has(pub.entityId)} onChange={() => toggle(pub.entityId)} className="mt-1" />
                <label htmlFor={`resolve-keep-${pub.entityId}`} className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
                  {pub.title}
                </label>
              </li>
            ))}
          </ul>
          <p className="text-xs text-amber-800 dark:text-amber-300 mb-3">{t('selected', { selected: selected.size, limit: publicationLimit ?? 0 })}</p>
          {error && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{error}</p>}
          <button
            onClick={submit}
            disabled={submitting || (publicationLimit !== null && selected.size > publicationLimit)}
            className="px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-50 transition-colors"
          >
            {submitting ? t('working') : t('confirmAction')}
          </button>
        </>
      )}
    </div>
  )
}
