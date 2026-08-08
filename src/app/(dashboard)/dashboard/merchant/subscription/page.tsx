'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeft, Check, TrendingDown } from 'lucide-react'
import { TestModeBanner } from '@/components/shared/test-mode-banner'

interface MerchantPlan {
  id: string
  display_name: string
  monthly_fee_cents: number
  currency: string
  sales_commission_bps: number
  rental_commission_bps: number
  active_listing_limit: number | null
}

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
  } | null
  listingUsage: { activeCount: number; limit: number | null; atLimit: boolean }
  economics: {
    currentMonthVolume: { salesVolumeCents: number; rentalVolumeCents: number }
    currentPlanCost: PlanCostBreakdown
    allPlanCosts: PlanCostBreakdown[]
    recommendations: (PlanCostBreakdown & { savingsCents: number })[]
  }
}

function money(cents: number): string {
  return `R${(cents / 100).toFixed(2)}`
}

function bps(n: number): string {
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 1)}%`
}

export default function MerchantSubscriptionPage() {
  const [data, setData] = useState<SubscriptionMe | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/subscriptions/me')
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load your subscription')
      }
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your subscription')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  async function changePlan(targetPlanId: string, currentRankHigherThanTarget: boolean) {
    setActionError(null)
    setBusyPlanId(targetPlanId)
    try {
      const endpoint = currentRankHigherThanTarget ? (targetPlanId === 'starter' ? '/api/subscriptions/cancel' : '/api/subscriptions/downgrade') : '/api/subscriptions/upgrade'
      const body: Record<string, unknown> = { idempotency_key: crypto.randomUUID() }
      if (endpoint !== '/api/subscriptions/cancel') body.targetPlanId = targetPlanId
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await res.json()
      if (!res.ok) {
        setActionError(result.error ?? 'Something went wrong')
        return
      }
      await load()
    } catch {
      setActionError('Network error — please try again')
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
        setActionError(result.error ?? 'Something went wrong')
        return
      }
      await load()
    } catch {
      setActionError('Network error — please try again')
    } finally {
      setBusyPlanId(null)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Merchant Account</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">Subscription</h1>
      </div>

      <TestModeBanner className="mb-8" />

      {loading ? (
        <p className="text-sm text-[#9B8B85]">Loading…</p>
      ) : error || !data ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error ?? 'Could not load your subscription'}</p>
      ) : (
        <>
          <div className="bg-[#8B1A1A] rounded-xl p-8 mb-6 border-l-4 border-l-[#C4511F]">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-white/60 mb-3">Current Plan</p>
            <div className="text-4xl font-extrabold text-white leading-none mb-2">{data.plan.display_name}</div>
            <p className="text-sm text-white/70">
              {data.plan.monthly_fee_cents === 0 ? 'Free' : `${money(data.plan.monthly_fee_cents)}/month`} · {bps(data.plan.sales_commission_bps)} sales · {bps(data.plan.rental_commission_bps)} rentals · 0% barter
            </p>
            {data.subscription?.status === 'pending_change' && data.subscription.pendingPlanId && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="text-xs text-white/70">
                  Scheduled to change to <span className="font-semibold text-white">{data.subscription.pendingPlanId}</span> on{' '}
                  {data.subscription.pendingPlanEffectiveAt ? new Date(data.subscription.pendingPlanEffectiveAt).toLocaleDateString('en-ZA') : '—'}
                </p>
                <button onClick={cancelPendingChange} disabled={busyPlanId !== null} className="text-xs underline text-white/90 hover:text-white disabled:opacity-50">
                  {busyPlanId === 'cancel-pending' ? 'Working…' : 'Cancel this change'}
                </button>
              </div>
            )}
            {data.subscription?.status === 'cancelled' && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <p className="text-xs text-white/70">
                  Reverting to Starter on {data.subscription.pendingPlanEffectiveAt ? new Date(data.subscription.pendingPlanEffectiveAt).toLocaleDateString('en-ZA') : '—'}
                </p>
                <button onClick={cancelPendingChange} disabled={busyPlanId !== null} className="text-xs underline text-white/90 hover:text-white disabled:opacity-50">
                  {busyPlanId === 'cancel-pending' ? 'Working…' : 'Keep my plan'}
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Active Listings</p>
              <div className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">
                {data.listingUsage.activeCount}
                {data.listingUsage.limit !== null && <span className="text-[#9B8B85] text-base"> / {data.listingUsage.limit}</span>}
              </div>
              {data.listingUsage.atLimit && <p className="text-[11px] text-red-600 dark:text-red-400 mt-1.5">Limit reached — upgrade to activate more</p>}
            </div>
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">This Month&rsquo;s Cost</p>
              <div className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{money(data.economics.currentPlanCost.totalCostCents)}</div>
            </div>
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Volume This Month</p>
              <div className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">
                {money(data.economics.currentMonthVolume.salesVolumeCents + data.economics.currentMonthVolume.rentalVolumeCents)}
              </div>
            </div>
          </div>

          {data.economics.recommendations.length > 0 && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900/40 rounded-xl p-5 mb-10 flex items-start gap-3">
              <TrendingDown size={18} className="text-green-700 dark:text-green-400 shrink-0 mt-0.5" />
              <p className="text-sm text-green-800 dark:text-green-300">
                Based on this month&rsquo;s volume, you could save{' '}
                <span className="font-semibold">{money(Math.max(...data.economics.recommendations.map((r) => r.savingsCents)))}</span> per month on the{' '}
                {data.economics.recommendations
                  .filter((r) => r.savingsCents === Math.max(...data.economics.recommendations.map((x) => x.savingsCents)))
                  .map((r) => r.planId)
                  .join(' or ')}{' '}
                plan.
              </p>
            </div>
          )}

          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">All Plans</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {data.economics.allPlanCosts.map((breakdown) => {
              const isCurrent = breakdown.planId === data.planId
              const currentRank = { starter: 0, pro: 1, elite: 2 }[data.planId] ?? 0
              const targetRank = { starter: 0, pro: 1, elite: 2 }[breakdown.planId] ?? 0
              const isCheapest = data.economics.recommendations.some((r) => r.planId === breakdown.planId) || isCurrent
              return (
                <div key={breakdown.planId} className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold capitalize text-[#1A0A0A] dark:text-[#F5F0ED]">{breakdown.planId}</p>
                    {isCurrent && <Check size={16} className="text-green-600" />}
                  </div>
                  <p className="text-lg font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">{money(breakdown.totalCostCents)}<span className="text-xs font-normal text-[#9B8B85]">/mo estimated</span></p>
                  {!isCurrent && (
                    <button
                      onClick={() => changePlan(breakdown.planId, targetRank < currentRank)}
                      disabled={busyPlanId !== null}
                      className="w-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors disabled:opacity-50"
                    >
                      {busyPlanId === breakdown.planId ? 'Working…' : targetRank > currentRank ? 'Upgrade' : 'Downgrade'}
                    </button>
                  )}
                  {isCheapest && !isCurrent && <p className="text-[11px] text-green-700 dark:text-green-400 mt-1.5">Cheapest for your volume</p>}
                </div>
              )
            })}
          </div>

          {actionError && <p className="text-xs text-red-600 dark:text-red-400 mb-6">{actionError}</p>}

          <p className="text-xs text-[#9B8B85] text-center">
            Upgrades apply immediately. Downgrades and cancellations take effect at the start of your next billing period — you keep your current plan&rsquo;s benefits until then.
          </p>
        </>
      )}
    </div>
  )
}
