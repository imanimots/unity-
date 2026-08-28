'use client'

import { useState, useEffect, useCallback, use } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { Locale } from '@/i18n/locales'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { formatMoney } from '@/lib/i18n/format'

interface AdCampaignReport {
  campaign_id: string
  status: string
  placement_type: string
  placement_tier: string
  position_band: string | null
  activated_at: string | null
  end_at: string | null
  completed_at: string | null
  purchased_impressions: number
  served_impressions: number
  estimated_reach: number
  valid_clicks: number
  ctr_percent: number
  delivered_percent: number
  remaining_impression_quota: number
  funded_amount_cents: number
  currency: string
  underdelivery_credit_cents: number
  base_price_cents: number
  discount_bps: number
  discount_cents: number
  subscription_plan_id: string
  pricing_is_live_quote: boolean
}

export default function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const locale = useLocale() as Locale
  const tAd = useTranslations('advertising')
  const money = useCallback((cents: number, currency: string) => formatMoney(cents, currency, locale), [locale])
  // Database enum values stay language-neutral (draft/funded/pending_review/
  // active/paused/completed/cancelled/rejected/suspended) -- only mapped to
  // a localized display label here, via the advertising.status.* namespace.
  const STATUS_LABEL: Record<string, string> = {
    draft: tAd('status.draft'), funded: tAd('status.funded'), pending_review: tAd('status.pendingReview'), active: tAd('status.active'),
    paused: tAd('status.paused'), completed: tAd('status.completed'), cancelled: tAd('status.cancelled'), rejected: tAd('status.rejected'), suspended: tAd('status.suspended'),
  }
  const [report, setReport] = useState<AdCampaignReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch(`/api/advertising/campaigns/${id}/report`)
    const data = await res.json()
    if (res.ok) setReport(data)
    setLoading(false)
  }, [id])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const fund = useCallback(async () => {
    setActionError(null)
    setActionBusy(true)
    try {
      const res = await fetch(`/api/advertising/campaigns/${id}/fund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fundingSource: 'provider', mockScenario: 'success' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data.error ?? 'Could not fund campaign')
      } else {
        await load()
      }
    } finally {
      setActionBusy(false)
    }
  }, [id, load])

  const runAction = useCallback(
    async (action: 'pause' | 'resume' | 'cancel') => {
      setActionError(null)
      setActionBusy(true)
      try {
        const res = await fetch(`/api/advertising/campaigns/${id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        const data = await res.json()
        if (!res.ok) {
          setActionError(data.error ?? `Could not ${action} campaign`)
        } else {
          await load()
        }
      } finally {
        setActionBusy(false)
      }
    },
    [id, load]
  )

  if (loading) {
    return <div className="max-w-2xl mx-auto px-6 py-10 text-sm text-[#9B8B85]">Loading…</div>
  }

  if (!report) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-sm text-[#9B8B85]">Campaign not found.</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <Link href="/dashboard/merchant/advertising" className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#8B1A1A] mb-6">
        <ArrowLeft size={14} /> Back to advertising
      </Link>

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
          {report.placement_type.replace(/_/g, ' ')}
        </h1>
        <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]">
          {STATUS_LABEL[report.status] ?? report.status}
        </span>
      </div>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">{report.placement_tier} tier{report.position_band ? ` · ${report.position_band}` : ''}</p>

      {actionError && <p className="text-sm text-red-500 mb-4">{actionError}</p>}

      {report.status === 'draft' && (
        <div className="mb-8 rounded-xl border border-dashed border-[#E8E0D8] dark:border-[#2A1A1A] px-5 py-4">
          <PricingBreakdown report={report} money={money} />
          <p className="text-xs text-[#9B8B85] mt-3 mb-3">
            This is a live preview, not a guaranteed price — it may change if the package price or your subscription plan changes before you fund. The final amount is locked in the moment you click Fund, before any charge happens.
          </p>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-3">
            Fund this campaign to activate it. This is a development mock charge — no real money moves.
          </p>
          <button
            onClick={fund}
            disabled={actionBusy}
            className="px-5 py-2.5 rounded-full text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors disabled:opacity-50"
          >
            Fund campaign
          </button>
        </div>
      )}

      {report.status !== 'draft' && (
        <div className="mb-8 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] px-5 py-4">
          <PricingBreakdown report={report} money={money} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-8">
        <Metric label="Purchased impressions" value={report.purchased_impressions.toLocaleString()} />
        <Metric label="Served impressions" value={report.served_impressions.toLocaleString()} />
        <Metric label="Estimated reach" value={report.estimated_reach.toLocaleString()} />
        <Metric label="Valid clicks" value={report.valid_clicks.toLocaleString()} />
        <Metric label="CTR" value={`${report.ctr_percent}%`} />
        <Metric label="Delivered" value={`${report.delivered_percent}%`} />
        <Metric label="Remaining quota" value={report.remaining_impression_quota.toLocaleString()} />
        <Metric label="Amount funded" value={money(report.funded_amount_cents, report.currency)} />
        {report.underdelivery_credit_cents > 0 && (
          <Metric label="Underdelivery credit" value={money(report.underdelivery_credit_cents, report.currency)} />
        )}
      </div>

      <div className="text-xs text-[#9B8B85] mb-8 space-y-1">
        {report.activated_at && <p>Activated {new Date(report.activated_at).toLocaleDateString()}</p>}
        {report.end_at && <p>Ends {new Date(report.end_at).toLocaleDateString()}</p>}
        {report.completed_at && <p>Completed {new Date(report.completed_at).toLocaleDateString()}</p>}
      </div>

      {(report.status === 'active' || report.status === 'paused') && (
        <div className="flex gap-3">
          {report.status === 'active' && (
            <button onClick={() => runAction('pause')} disabled={actionBusy} className="px-4 py-2 rounded-full text-sm font-semibold border border-[#E8E0D8] dark:border-[#2A1A1A] hover:border-[#8B1A1A] transition-colors disabled:opacity-50">
              Pause
            </button>
          )}
          {report.status === 'paused' && (
            <button onClick={() => runAction('resume')} disabled={actionBusy} className="px-4 py-2 rounded-full text-sm font-semibold border border-[#E8E0D8] dark:border-[#2A1A1A] hover:border-[#8B1A1A] transition-colors disabled:opacity-50">
              Resume
            </button>
          )}
          <button onClick={() => runAction('cancel')} disabled={actionBusy} className="px-4 py-2 rounded-full text-sm font-semibold text-red-500 border border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50">
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

/** Package price -> subscription discount -> amount due, server-derived throughout (never client-computed). */
function PricingBreakdown({ report, money }: { report: AdCampaignReport; money: (cents: number, currency: string) => string }) {
  const planLabel = report.subscription_plan_id ? report.subscription_plan_id.charAt(0).toUpperCase() + report.subscription_plan_id.slice(1) : ''
  const discountPercent = report.discount_bps / 100
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#9B8B85] mb-2">
        {report.pricing_is_live_quote ? 'Pricing' : 'Amount charged'}
      </p>
      <div className="flex justify-between text-sm">
        <span className="text-[#6B5B55] dark:text-[#9B8B85]">Package price</span>
        <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{money(report.base_price_cents, report.currency)}</span>
      </div>
      {report.discount_bps > 0 && (
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">
            {planLabel} discount ({discountPercent}%)
          </span>
          <span className="font-medium text-[#1A7A3A]">-{money(report.discount_cents, report.currency)}</span>
        </div>
      )}
      <div className="flex justify-between text-sm pt-1.5 mt-1.5 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
        <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{report.pricing_is_live_quote ? 'Amount due' : 'Amount charged'}</span>
        <span className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{money(report.funded_amount_cents, report.currency)}</span>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] px-4 py-3">
      <p className="text-xs text-[#9B8B85] mb-0.5">{label}</p>
      <p className="text-sm font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{value}</p>
    </div>
  )
}
