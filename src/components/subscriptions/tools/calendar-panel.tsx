'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import type { MerchantCalendarView } from '@/lib/subscriptions/calendar'

/** Section 9-10: merchant operations view built from existing authoritative data only -- never a fabricated stock/ERP concept. */
export function CalendarPanel() {
  const t = useTranslations('merchant.tools.calendar')
  const [data, setData] = useState<MerchantCalendarView | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/subscriptions/calendar')
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  if (loading) return <p className="text-sm text-[#9B8B85]">{t('loading')}</p>
  if (!data) return <p className="text-sm text-[#9B8B85]">{t('couldNotLoad')}</p>

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] mb-3">{t('upcomingBookings')}</p>
        {data.upcomingBookings.length === 0 ? (
          <p className="text-sm text-[#9B8B85]">{t('noUpcomingBookings')}</p>
        ) : (
          <ul className="space-y-2">
            {data.upcomingBookings.map((b) => (
              <li key={b.id} className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] flex justify-between">
                <span>{b.listingTitle}</span>
                <span className="text-[#6B5B55] dark:text-[#9B8B85]">
                  {b.startDate} → {b.endDate}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] mb-3">{t('listingStatus')}</p>
        <ul className="space-y-1">
          {data.listings.map((l) => (
            <li key={l.id} className="text-sm flex justify-between">
              <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{l.title}</span>
              <span className="text-[#6B5B55] dark:text-[#9B8B85] uppercase text-xs">{l.status}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
