'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'

interface ScheduleRow {
  id: string
  entity_type: string
  entity_id: string
  scheduled_at: string
  status: string
  block_reason: string | null
}

/** Section 3-4: Pro/Elite scheduled-publishing status list, with cancel where safe. Server-authoritative -- no browser timer, this only displays server-owned state. */
export function ScheduledPublicationsPanel() {
  const t = useTranslations('merchant.tools.schedule')
  const [items, setItems] = useState<ScheduleRow[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/subscriptions/scheduled-publications')
    if (res.ok) setItems((await res.json()).items)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  async function cancel(id: string) {
    setBusyId(id)
    try {
      await fetch(`/api/subscriptions/scheduled-publications/${id}/cancel`, { method: 'POST' })
      await load()
    } finally {
      setBusyId(null)
    }
  }

  if (!items) return <p className="text-sm text-[#9B8B85]">{t('loading')}</p>
  if (items.length === 0) return <p className="text-sm text-[#9B8B85]">{t('none')}</p>

  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6">
      <p className="text-xs text-[#9B8B85] mb-4">{t('description')}</p>
      <ul className="space-y-3">
        {items.map((s) => (
          <li key={s.id} className="flex items-center justify-between text-sm">
            <div>
              <p className="text-[#1A0A0A] dark:text-[#F5F0ED]">
                {s.entity_type} · {new Date(s.scheduled_at).toLocaleString()}
              </p>
              <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] uppercase">
                {s.status}
                {s.block_reason ? ` — ${s.block_reason}` : ''}
              </p>
            </div>
            {s.status === 'pending' && (
              <button onClick={() => cancel(s.id)} disabled={busyId === s.id} className="text-xs underline text-[#8B1A1A] disabled:opacity-50">
                {busyId === s.id ? t('working') : t('cancelAction')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
