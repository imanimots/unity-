'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import type { DemandInsightsResult } from '@/lib/subscriptions/demand'

/** Section 11-12/16: Pro/Elite demand intelligence. Shows only privacy-safe, threshold-met aggregate buckets -- never a fabricated trend. */
export function DemandInsightsPanel() {
  const t = useTranslations('merchant.tools.demand')
  const [data, setData] = useState<DemandInsightsResult | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/subscriptions/demand-insights')
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
  if (!data || !data.hasSufficientData) return <p className="text-sm text-[#9B8B85]">{t('insufficientData')}</p>

  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6">
      <p className="text-xs text-[#9B8B85] mb-4">{t('windowNotice', { days: data.windowDays })}</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
            <th className="py-2">{t('columns.category')}</th>
            <th className="py-2">{t('columns.mode')}</th>
            <th className="py-2">{t('columns.searches')}</th>
            <th className="py-2">{t('columns.zeroResultShare')}</th>
          </tr>
        </thead>
        <tbody>
          {data.trends.map((trend, i) => (
            <tr key={i} className="border-b border-[#F2EDE8]/50 dark:border-[#2A1A1A]/50">
              <td className="py-2 text-[#1A0A0A] dark:text-[#F5F0ED]">{trend.category ?? t('columns.allCategories')}</td>
              <td className="py-2 text-[#6B5B55] dark:text-[#9B8B85]">{trend.mode ?? '—'}</td>
              <td className="py-2 text-[#1A0A0A] dark:text-[#F5F0ED]">{trend.searchCount}</td>
              <td className="py-2 text-[#6B5B55] dark:text-[#9B8B85]">{(trend.zeroResultShare * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
