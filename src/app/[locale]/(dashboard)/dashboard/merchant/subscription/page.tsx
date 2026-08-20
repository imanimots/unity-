'use client'

import { useState, useEffect, useCallback } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { Locale } from '@/i18n/locales'
import { ArrowLeft, Check, TrendingDown } from 'lucide-react'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import { formatMoney, formatDate } from '@/lib/i18n/format'
import type { MerchantSubscriptionPlan } from '@/types'
import { DowngradeConsentModal } from '@/components/subscriptions/downgrade-consent-modal'
import { ResolveFrozenBanner } from '@/components/subscriptions/resolve-frozen-banner'
import { BusinessNameSettings } from '@/components/subscriptions/business-name-settings'

type MerchantPlan = MerchantSubscriptionPlan

interface PlanCostBreakdown {
  planId: string
  monthlyFeeCents: number
  salesCommissionCents: number
  rentalCommissionCents: number
  totalCostCents: number
}

interface SubscriptionMe {
  planId: string
  plan: MerchantPlan
  subscription: {
    status: 'active' | 'pending_change' | 'cancelled'
    pendingPlanId: string | null
    pendingPlanEffectiveAt: string | null
    publicationFrozen: boolean
  } | null
  publicationUsage: { activeCount: number; limit: number | null; atLimit: boolean }
  economics: {
    currentMonthVolume: { salesVolumeCents: number; rentalVolumeCents: number }
    currentPlanCost: PlanCostBreakdown
    allPlanCosts: PlanCostBreakdown[]
    recommendations: (PlanCostBreakdown & { savingsCents: number })[]
  }
}

// Locale-aware: defined inline where `locale` is in scope (see the
// component body's `const locale = useLocale() as Locale`) rather than accepting it
// as a call-site parameter, so every existing `money(cents)` call site
// below is unaffected.

function bps(n: number): string {
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 1)}%`
}

export default function MerchantSubscriptionPage() {
  const locale = useLocale() as Locale
  const t = useTranslations('merchant.subscriptionPage')
  const tPlanNames = useTranslations('merchant.subscription')
  const money = useCallback((cents: number) => formatMoney(cents, 'ZAR', locale), [locale])
  const [data, setData] = useState<SubscriptionMe | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [plans, setPlans] = useState<MerchantSubscriptionPlan[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [meRes, plansRes] = await Promise.all([fetch('/api/subscriptions/me'), fetch('/api/subscriptions/plans')])
      if (!meRes.ok) {
        const b = await meRes.json().catch(() => ({}))
        throw new Error(b.error ?? t('couldNotLoad'))
      }
      setData(await meRes.json())
      if (plansRes.ok) setPlans((await plansRes.json()).plans ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('couldNotLoad'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const [downgradeTargetId, setDowngradeTargetId] = useState<string | null>(null)

  async function changePlan(targetPlanId: string, currentRankHigherThanTarget: boolean) {
    // Downgrades/cancellations never fire immediately from here -- they
    // open the deliberate Section 52 consequence flow instead. Only an
    // upgrade is a direct, immediate action (Section 51).
    if (currentRankHigherThanTarget) {
      setDowngradeTargetId(targetPlanId)
      return
    }

    setActionError(null)
    setBusyPlanId(targetPlanId)
    try {
      const res = await fetch('/api/subscriptions/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPlanId, idempotency_key: crypto.randomUUID() }),
      })
      const result = await res.json()
      if (!res.ok) {
        setActionError(result.error ?? t('errors.somethingWentWrong'))
        return
      }
      await load()
    } catch {
      setActionError(t('errors.networkError'))
    } finally {
      setBusyPlanId(null)
    }
  }

  async function cancelPendingChange() {
    setActionError(null)
    setBusyPlanId('cancel-pending')
    try {
      const res = await fetch('/api/subscriptions/cancel-pending-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
      })
      const result = await res.json()
      if (!res.ok) {
        setActionError(result.error ?? t('errors.somethingWentWrong'))
        return
      }
      await load()
    } catch {
      setActionError(t('errors.networkError'))
    } finally {
      setBusyPlanId(null)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
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
      ) : error || !data ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error ?? t('couldNotLoad')}</p>
      ) : (
        <>
          {data.subscription?.publicationFrozen && <ResolveFrozenBanner publicationLimit={data.plan.active_publication_limit} onResolved={() => void load()} />}

          <div className="bg-[#8B1A1A] rounded-xl p-8 mb-6 border-l-4 border-l-[#C4511F]">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-white/60 mb-3">{t('currentPlanLabel')}</p>
            <div className="text-4xl font-extrabold text-white leading-none mb-2">{data.plan.display_name}</div>
            <p className="text-sm text-white/70">
              {data.plan.monthly_fee_cents === 0 ? t('free') : `${money(data.plan.monthly_fee_cents)}${t('perMonth')}`} · {bps(data.plan.sales_commission_bps)} {t('salesSuffix')} · {bps(data.plan.rental_commission_bps)} {t('rentalsSuffix')} · 0% {t('barterSuffix')}
            </p>
            {data.subscription?.status === 'pending_change' && data.subscription.pendingPlanId && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="text-xs text-white/70">
                  {t.rich('scheduledChange', {
                    b: (chunks) => <span className="font-semibold text-white">{chunks}</span>,
                    plan: data.subscription.pendingPlanId ?? '',
                    date: data.subscription.pendingPlanEffectiveAt ? formatDate(data.subscription.pendingPlanEffectiveAt, locale) : '—',
                  })}
                </p>
                <button onClick={cancelPendingChange} disabled={busyPlanId !== null} className="text-xs underline text-white/90 hover:text-white disabled:opacity-50">
                  {busyPlanId === 'cancel-pending' ? t('working') : t('cancelThisChange')}
                </button>
              </div>
            )}
            {data.subscription?.status === 'cancelled' && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="text-xs text-white/70">
                  {t('revertingToStarter', { date: data.subscription.pendingPlanEffectiveAt ? formatDate(data.subscription.pendingPlanEffectiveAt, locale) : '—' })}
                </p>
                <button onClick={cancelPendingChange} disabled={busyPlanId !== null} className="text-xs underline text-white/90 hover:text-white disabled:opacity-50">
                  {busyPlanId === 'cancel-pending' ? t('working') : t('keepMyPlan')}
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{t('activeListings')}</p>
              <div className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">
                {data.publicationUsage.activeCount}
                {data.publicationUsage.limit !== null && <span className="text-[#9B8B85] text-base"> / {data.publicationUsage.limit}</span>}
              </div>
              {data.publicationUsage.atLimit && <p className="text-[11px] text-red-600 dark:text-red-400 mt-1.5">{t('limitReached')}</p>}
            </div>
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{t('thisMonthsCost')}</p>
              <div className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{money(data.economics.currentPlanCost.totalCostCents)}</div>
            </div>
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{t('volumeThisMonth')}</p>
              <div className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">
                {money(data.economics.currentMonthVolume.salesVolumeCents + data.economics.currentMonthVolume.rentalVolumeCents)}
              </div>
            </div>
          </div>

          {data.economics.recommendations.length > 0 && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900/40 rounded-xl p-5 mb-10 flex items-start gap-3">
              <TrendingDown size={18} className="text-green-700 dark:text-green-400 shrink-0 mt-0.5" />
              <p className="text-sm text-green-800 dark:text-green-300">
                {t('savingsNotice', {
                  amount: money(Math.max(...data.economics.recommendations.map((r) => r.savingsCents))),
                  plans: data.economics.recommendations
                    .filter((r) => r.savingsCents === Math.max(...data.economics.recommendations.map((x) => x.savingsCents)))
                    .map((r) => r.planId)
                    .join(' / '),
                })}
              </p>
            </div>
          )}

          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">{t('allPlans')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {data.economics.allPlanCosts.map((breakdown) => {
              const isCurrent = breakdown.planId === data.planId
              const currentRank = { starter: 0, pro: 1, elite: 2 }[data.planId] ?? 0
              const targetRank = { starter: 0, pro: 1, elite: 2 }[breakdown.planId] ?? 0
              const isCheapest = data.economics.recommendations.some((r) => r.planId === breakdown.planId) || isCurrent
              return (
                <div key={breakdown.planId} className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{tPlanNames(breakdown.planId as 'starter' | 'pro' | 'elite')}</p>
                    {isCurrent && <Check size={16} className="text-green-600" />}
                  </div>
                  <p className="text-lg font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">{money(breakdown.totalCostCents)}<span className="text-xs font-normal text-[#9B8B85]">{t('estimatedPerMonth')}</span></p>
                  {!isCurrent && (
                    <button
                      onClick={() => changePlan(breakdown.planId, targetRank < currentRank)}
                      disabled={busyPlanId !== null}
                      className="w-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors disabled:opacity-50"
                    >
                      {busyPlanId === breakdown.planId ? t('working') : targetRank > currentRank ? t('upgrade') : t('downgrade')}
                    </button>
                  )}
                  {isCheapest && !isCurrent && <p className="text-[11px] text-green-700 dark:text-green-400 mt-1.5">{t('cheapestForVolume')}</p>}
                </div>
              )
            })}
          </div>

          {actionError && <p className="text-xs text-red-600 dark:text-red-400 mb-6">{actionError}</p>}

          <BusinessNameSettings />

          <p className="text-xs text-[#9B8B85] text-center">
            {t('billingNotice')}
          </p>

          {downgradeTargetId &&
            (() => {
              const targetPlan = plans.find((p) => p.id === downgradeTargetId)
              if (!targetPlan) return null
              return (
                <DowngradeConsentModal
                  currentPlan={data.plan}
                  targetPlan={targetPlan}
                  onClose={() => setDowngradeTargetId(null)}
                  onConfirmed={() => {
                    setDowngradeTargetId(null)
                    void load()
                  }}
                />
              )
            })()}
        </>
      )}
    </div>
  )
}
