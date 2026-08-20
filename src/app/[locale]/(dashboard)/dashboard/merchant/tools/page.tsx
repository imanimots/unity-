'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import type { MerchantEntitlements } from '@/lib/subscriptions/entitlements'
import { DemandInsightsPanel } from '@/components/subscriptions/tools/demand-insights-panel'
import { CalendarPanel } from '@/components/subscriptions/tools/calendar-panel'
import { ScheduledPublicationsPanel } from '@/components/subscriptions/tools/scheduled-publications-panel'
import { CsvToolsPanel } from '@/components/subscriptions/tools/csv-tools-panel'
import { BulkPricePanel } from '@/components/subscriptions/tools/bulk-price-panel'
import { AiAssistantPanel } from '@/components/subscriptions/tools/ai-assistant-panel'

type Tab = 'demand' | 'calendar' | 'schedule' | 'csv' | 'price' | 'ai'

/**
 * Consolidated Pro/Elite merchant tools surface (Section 4/9/11/14) --
 * one page with distinct sections rather than five separately-routed
 * pages, each panel independently fetching + entitlement-checking
 * against its own server route (never trusting a client-side flag as
 * the real gate -- every panel's underlying API route re-checks
 * entitlement itself).
 */
export default function MerchantToolsPage() {
  const t = useTranslations('merchant.tools')
  const [entitlements, setEntitlements] = useState<MerchantEntitlements | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('demand')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/subscriptions/me')
      if (res.ok) setEntitlements((await res.json()).entitlements)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const TABS: { id: Tab; label: string; enabled: boolean }[] = entitlements
    ? [
        { id: 'demand', label: t('tabs.demand'), enabled: entitlements.demandInsightsEnabled },
        { id: 'calendar', label: t('tabs.calendar'), enabled: entitlements.inventoryCalendarEnabled },
        { id: 'schedule', label: t('tabs.schedule'), enabled: entitlements.scheduledPublishingEnabled },
        { id: 'csv', label: t('tabs.csv'), enabled: entitlements.csvImportEnabled || entitlements.csvExportEnabled },
        { id: 'price', label: t('tabs.price'), enabled: entitlements.bulkPriceUpdateEnabled },
        { id: 'ai', label: t('tabs.ai'), enabled: entitlements.listingAssistantEnabled || entitlements.analyticsAssistantEnabled },
      ]
    : []

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> {t('backLabel')}
        </Link>
      </div>

      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{t('eyebrow')}</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">{t('heading')}</h1>
      </div>

      <TestModeBanner className="mb-8" />

      {loading ? (
        <p className="text-sm text-[#9B8B85]">{t('loading')}</p>
      ) : !entitlements || TABS.every((tb) => !tb.enabled) ? (
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-8 text-center">
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-4">{t('starterExplanation')}</p>
          <Link href="/dashboard/merchant/subscription" className="inline-block px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors">
            {t('upgradeAction')}
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-8">
            {TABS.filter((tb) => tb.enabled).map((tb) => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={`px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors ${
                  tab === tb.id ? 'bg-[#8B1A1A] text-white' : 'bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]'
                }`}
              >
                {tb.label}
              </button>
            ))}
          </div>

          {tab === 'demand' && entitlements.demandInsightsEnabled && <DemandInsightsPanel />}
          {tab === 'calendar' && entitlements.inventoryCalendarEnabled && <CalendarPanel />}
          {tab === 'schedule' && entitlements.scheduledPublishingEnabled && <ScheduledPublicationsPanel />}
          {tab === 'csv' && (entitlements.csvImportEnabled || entitlements.csvExportEnabled) && <CsvToolsPanel />}
          {tab === 'price' && entitlements.bulkPriceUpdateEnabled && <BulkPricePanel />}
          {tab === 'ai' && (entitlements.listingAssistantEnabled || entitlements.analyticsAssistantEnabled) && <AiAssistantPanel entitlements={entitlements} />}
        </>
      )}
    </div>
  )
}
