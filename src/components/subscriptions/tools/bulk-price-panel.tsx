'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'

interface ListingRow {
  id: string
  title: string
}

/** Section 8: Pro/Elite bulk price updates. Requires explicit confirmation before applying; only touches future listing terms. */
export function BulkPricePanel() {
  const t = useTranslations('merchant.tools.bulkPrice')
  const [listings, setListings] = useState<ListingRow[] | null>(null)
  const [dailyRate, setDailyRate] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/subscriptions/me/publications')
    if (res.ok) {
      const items = (await res.json()).items as { entityType: string; entityId: string; title: string }[]
      setListings(items.filter((i) => i.entityType === 'listing').map((i) => ({ id: i.entityId, title: i.title })))
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function apply() {
    setSubmitting(true)
    setResult(null)
    try {
      const rate = Number(dailyRate)
      const res = await fetch('/api/listings/bulk-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [...selected].map((listingId) => ({ listingId, dailyRate: rate })) }),
      })
      const body = await res.json()
      if (!res.ok) {
        setResult(body.error ?? t('genericError'))
        return
      }
      setResult(t('success', { count: (body.results as { ok: boolean }[]).filter((r) => r.ok).length }))
      setConfirming(false)
    } catch {
      setResult(t('genericError'))
    } finally {
      setSubmitting(false)
    }
  }

  if (!listings) return <p className="text-sm text-[#9B8B85]">{t('loading')}</p>

  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] mb-4">{t('title')}</p>
      <ul className="space-y-2 mb-4 max-h-64 overflow-y-auto">
        {listings.map((l) => (
          <li key={l.id} className="flex items-center gap-2">
            <input type="checkbox" id={`price-${l.id}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
            <label htmlFor={`price-${l.id}`} className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
              {l.title}
            </label>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 mb-4">
        <label className="text-xs text-[#9B8B85]">{t('newDailyRate')}</label>
        <input type="number" min={0} value={dailyRate} onChange={(e) => setDailyRate(e.target.value)} className="px-3 py-1.5 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent text-sm w-32" />
      </div>
      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          disabled={selected.size === 0 || !dailyRate}
          className="px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-40 transition-colors"
        >
          {t('reviewAction')}
        </button>
      ) : (
        <div>
          <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">{t('confirmMessage', { count: selected.size, rate: dailyRate })}</p>
          <div className="flex gap-3">
            <button onClick={() => setConfirming(false)} className="text-xs uppercase text-[#9B8B85]">
              {t('backAction')}
            </button>
            <button onClick={apply} disabled={submitting} className="px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-50 transition-colors">
              {submitting ? t('working') : t('confirmAction')}
            </button>
          </div>
        </div>
      )}
      {result && <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-3">{result}</p>}
    </div>
  )
}
