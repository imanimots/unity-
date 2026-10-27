'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { AdminPageHeader, StatCard } from '@/components/admin/ui'
import type {
  AnalyticsPeriod, MarketplaceOverview, SupplyAnalytics, DemandAnalytics,
  TransactionAnalytics, TrustAnalytics, CommercialAnalytics, SupportAnalytics,
  GrowthAnalytics, PeriodComparison, BehaviorAnalytics, FunnelMetric,
} from '@/lib/admin/analytics-service'

interface AnalyticsResponse {
  period: AnalyticsPeriod
  marketplace: MarketplaceOverview
  supply: SupplyAnalytics
  demand: DemandAnalytics
  transactions: TransactionAnalytics
  trust: TrustAnalytics
  commercial: CommercialAnalytics
  support: SupportAnalytics
  growth: GrowthAnalytics
  behavior: BehaviorAnalytics
}

const PERIODS: { value: AnalyticsPeriod; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
]

function Section({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-4">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">{eyebrow}</p>
        <h2 className="text-base font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{title}</h2>
      </div>
      {children}
    </section>
  )
}

/** A compact breakdown table -- used for every "by status/category/province" list in this dashboard, so one real definition renders consistently everywhere. */
function BreakdownTable({ rows, labelHeader = 'Label', emptyLabel = 'No data for this period.' }: { rows: Array<{ label: string; count: number }>; labelHeader?: string; emptyLabel?: string }) {
  if (rows.length === 0) return <p className="text-xs text-[#9B8B85]">{emptyLabel}</p>
  const total = rows.reduce((s, r) => s + r.count, 0)
  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <th className="text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] pb-2">{labelHeader}</th>
          <th className="text-right text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] pb-2">Count</th>
          <th className="text-right text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] pb-2">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
            <td className="py-2 text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{r.label.replace(/_/g, ' ')}</td>
            <td className="py-2 text-right tabular-nums text-[#1A0A0A] dark:text-[#F5F0ED]">{r.count}</td>
            <td className="py-2 text-right tabular-nums text-[#9B8B85]">{total > 0 ? `${Math.round((r.count / total) * 100)}%` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Current value with an optional previous-period delta -- never a fabricated percentage when `previous` is null (e.g. period = All time). */
function TrendStat({ label, trend, helper }: { label: string; trend: PeriodComparison; helper?: string }) {
  const delta = trend.previous !== null ? trend.current - trend.previous : null
  return (
    <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">{label}</p>
      <p className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{trend.current}</p>
      {delta !== null ? (
        <p className={`text-xs mt-1 ${delta >= 0 ? 'text-green-700' : 'text-red-600'}`}>
          {delta >= 0 ? '+' : ''}{delta} vs previous period ({trend.previous})
        </p>
      ) : (
        <p className="text-xs text-[#9B8B85] mt-1">No comparable previous period</p>
      )}
      {helper ? <p className="text-[10px] text-[#9B8B85] mt-1">{helper}</p> : null}
    </div>
  )
}

/** A simple aggregate started/completed ratio -- deliberately labeled as an event-count rate, never a per-user cohort conversion (Section 28). Shows "—" rather than 0%/NaN/Infinity when there is nothing to divide by. */
function FunnelStat({ label, funnel }: { label: string; funnel: FunnelMetric }) {
  return (
    <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">{label}</p>
      <p className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">
        {funnel.started} → {funnel.completed}
      </p>
      <p className="text-xs text-[#9B8B85] mt-1">
        {funnel.conversionRate === null ? '—' : `${Math.round(funnel.conversionRate * 100)}% completion rate`}
      </p>
    </div>
  )
}

export default function AdminAnalyticsPage() {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [data, setData] = useState<AnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/analytics?period=${period}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load analytics')
      }
      setData(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load analytics')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  return (
    <div className="p-6 lg:p-8 max-w-[1400px] space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <AdminPageHeader eyebrow="Real marketplace data" title="Analytics" />
        <div className="flex items-center gap-1 bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] transition-colors ${
                period === p.value ? 'bg-[#8B1A1A] text-white' : 'text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-[#9B8B85] py-16 text-center">Loading real analytics…</p>
      ) : error || !data ? (
        <p className="text-sm text-red-600 py-16 text-center">{error ?? 'Not available'}</p>
      ) : (
        <>
          {/* ── Marketplace overview KPIs ── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCard label="Total users" value={data.marketplace.totalUsers} />
            <StatCard label="Non-erased users" value={data.marketplace.nonErasedUsers} />
            <StatCard label="Merchant-role users" value={data.marketplace.merchantUsers} />
            <StatCard label="Renter-role users" value={data.marketplace.renterUsers} />
            <StatCard label="Real active listings" value={data.marketplace.realActiveListings} />
            <StatCard label="Real active merchants" value={data.marketplace.realActiveMerchants} />
          </div>
          <p className="text-[11px] text-[#9B8B85]">
            &quot;Real&quot; excludes QA/demo listings (is_test = false). &quot;Non-erased&quot; excludes accounts that completed account erasure — this platform has no login/session-activity tracking, so no number here is labeled &quot;active user&quot;.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TrendStat label="New users" trend={data.marketplace.newUsers} />
            <TrendStat label="New real listings" trend={data.marketplace.newRealListings} />
          </div>

          {/* ── Supply ── */}
          <Section eyebrow="Marketplace" title="Supply">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Active listings by category</h3>
                <BreakdownTable rows={data.supply.listingsByCategory} labelHeader="Category" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Active listings by province</h3>
                <BreakdownTable rows={data.supply.listingsByProvince} labelHeader="Province" />
              </div>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Listing creation trend (this period, SAST)</h3>
              {data.supply.listingCreationTrend.length === 0 ? (
                <p className="text-xs text-[#9B8B85]">No new real listings in this period.</p>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={data.supply.listingCreationTrend} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F2EDE8" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#9B8B85' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: '#9B8B85' }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" name="New listings" stroke="#8B1A1A" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Data quality (among real active listings)</h3>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <StatCard label="Missing province" value={data.supply.dataQuality.missingProvince} />
                <StatCard label="Missing city" value={data.supply.dataQuality.missingCity} />
                <StatCard label="Missing collection area" value={data.supply.dataQuality.missingCollectionArea} />
                <StatCard label="< 3 photos" value={data.supply.dataQuality.insufficientMedia} />
                <StatCard label="Ownership verified" value={`${data.supply.dataQuality.ownershipVerifiedCount}/${data.supply.dataQuality.ownershipVerifiedCount + data.supply.dataQuality.ownershipNotVerifiedCount}`} />
              </div>
            </div>
          </Section>

          {/* ── Demand ── */}
          <Section eyebrow="Marketplace" title="Demand / search signals">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">
                Search demand by category ({data.demand.searchDemand.windowDays}-day window)
              </h3>
              {!data.demand.searchDemand.hasSufficientData ? (
                <p className="text-xs text-[#9B8B85]">Not enough aggregated search volume yet to show this safely without risking identifying individual searches.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      {['Category', 'Mode', 'Searches', 'Zero-result share'].map((h) => (
                        <th key={h} className="text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] pb-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.demand.searchDemand.trends.map((t) => (
                      <tr key={`${t.mode}-${t.category}`} className="border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
                        <td className="py-2 text-[#1A0A0A] dark:text-[#F5F0ED]">{t.category ?? '—'}</td>
                        <td className="py-2 text-[#6B5B55] dark:text-[#9B8B85] capitalize">{t.mode ?? '—'}</td>
                        <td className="py-2 tabular-nums">{t.searchCount}</td>
                        <td className="py-2 tabular-nums">{Math.round(t.zeroResultShare * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">&quot;Looking For&quot; requests by category</h3>
                <BreakdownTable rows={data.demand.lookingFor.byCategory} labelHeader="Category" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">&quot;Looking For&quot; requests by status</h3>
                <BreakdownTable rows={data.demand.lookingFor.byStatus} labelHeader="Status" />
              </div>
            </div>
          </Section>

          {/* ── Transactions ── */}
          <Section eyebrow="Marketplace" title="Transaction activity">
            <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
              Revenue/GMV is not shown — Unity&apos;s live payment provider is not fully connected, so no rand figure here would reflect real settled cash.
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {[data.transactions.bookings, data.transactions.orders, data.transactions.barter, data.transactions.rentToBuy, data.transactions.lookingFor].map((d) => (
                <div key={d.domain}>
                  <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">{d.domain} ({d.total})</h3>
                  {d.mayIncludeTestData ? (
                    <p className="text-[10px] text-amber-700 mb-1">May include QA/test activity — no reliable exclusion exists for this domain.</p>
                  ) : null}
                  <BreakdownTable rows={d.byStatus} labelHeader="Status" />
                </div>
              ))}
            </div>
          </Section>

          {/* ── Trust & Safety ── */}
          <Section eyebrow="Operations" title="Trust & verification">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">KYC status (all users)</h3>
                <BreakdownTable rows={data.trust.kycByStatus} labelHeader="KYC status" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Ownership verification status</h3>
                <BreakdownTable rows={data.trust.ownershipVerificationByStatus} labelHeader="Status" />
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Disputes ({data.trust.disputesByStatus.total} this period)</h3>
                {data.trust.disputesByStatus.mayIncludeTestData ? (
                  <p className="text-[10px] text-amber-700 mb-1">May include QA/test activity — no reliable exclusion exists for this domain.</p>
                ) : null}
                <BreakdownTable rows={data.trust.disputesByStatus.byStatus} labelHeader="Status" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Published reviews (period)" value={data.trust.publishedReviews} />
                <StatCard label="Restricted accounts" value={data.trust.accountRestrictions.restricted} />
                <StatCard label="Suspended accounts" value={data.trust.accountRestrictions.suspended} />
              </div>
            </div>
          </Section>

          {/* ── Commercial operations ── */}
          <Section eyebrow="Operations" title="Commercial operations">
            <p className="text-[11px] text-[#9B8B85]">
              These are recorded rows in Unity&apos;s own ledger tables, not confirmed cash settlement — the live payment/payout provider is not fully connected yet.
            </p>
            {data.commercial.notes.map((note) => (
              <p key={note} className="text-[10px] text-amber-700">{note}</p>
            ))}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Recorded Unity commissions</h3>
                <BreakdownTable rows={data.commercial.unityCommissionsByStatus} labelHeader="Status" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Merchant payout records</h3>
                <BreakdownTable rows={data.commercial.merchantPayoutsByStatus} labelHeader="Status" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Recorded affiliate commissions</h3>
                <BreakdownTable rows={data.commercial.affiliateCommissionsByStatus} labelHeader="Status" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Subscription records by status</h3>
                <BreakdownTable rows={data.commercial.subscriptionsByStatus} labelHeader="Status" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Subscriptions by plan</h3>
                <BreakdownTable rows={data.commercial.subscriptionsByPlan} labelHeader="Plan" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Advertising campaign records</h3>
                <BreakdownTable rows={data.commercial.advertisingCampaignsByStatus} labelHeader="Status" />
              </div>
            </div>
          </Section>

          {/* ── Support ── */}
          <Section eyebrow="Operations" title="Support">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Cases by status ({data.support.total} this period)</h3>
                <BreakdownTable rows={data.support.byStatus} labelHeader="Status" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Cases by priority</h3>
                <BreakdownTable rows={data.support.byPriority} labelHeader="Priority" />
              </div>
              <div>
                <h3 className="text-xs font-bold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Cases by category</h3>
                <BreakdownTable rows={data.support.byCategory} labelHeader="Category" />
              </div>
            </div>
          </Section>

          {/* ── Growth proxies ── */}
          <Section eyebrow="Operations" title="Growth proxies">
            <p className="text-[11px] text-[#9B8B85]">
              These are simple new-record counts, labeled as proxies — not a defined retention metric (there is no login/activity-tracking table to compute real retention from yet).
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <TrendStat label="New users" trend={data.growth.newUsers} />
              <TrendStat label="New merchants" trend={data.growth.newMerchants} />
              <TrendStat label="New real listings" trend={data.growth.newRealListings} />
              <TrendStat label="New bookings" trend={data.growth.newBookings} />
              <TrendStat label="New orders" trend={data.growth.newOrders} />
            </div>
          </Section>

          {/* ── Behavior & Conversion (D2) ── */}
          <Section eyebrow="Behavioral" title="Behavior & Conversion">
            {!data.behavior.dataQuality.hasAnyEventData ? (
              <p className="text-xs text-[#9B8B85]">No activity yet — first-party event tracking has no data for this environment yet.</p>
            ) : (
              <>
                {data.behavior.dataQuality.notes.map((note) => (
                  <p key={note} className="text-[10px] text-amber-700">{note}</p>
                ))}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                  <StatCard label="Page views" value={data.behavior.pageViews} />
                  <StatCard label="Searches started" value={data.behavior.searchStarted} />
                  <StatCard label="Zero-result searches" value={data.behavior.zeroResultSearches} />
                  <StatCard label="Zero-result rate" value={data.behavior.zeroResultRate === null ? '—' : `${Math.round(data.behavior.zeroResultRate * 100)}%`} />
                  <StatCard label="Listing views" value={data.behavior.listingViews} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                  <FunnelStat label="Signup" funnel={data.behavior.signupFunnel} />
                  <FunnelStat label="Listing publishing" funnel={data.behavior.listingCreationFunnel} />
                  <FunnelStat label="Rental checkout" funnel={data.behavior.rentalFunnel} />
                  <FunnelStat label="Buy checkout" funnel={data.behavior.orderFunnel} />
                  <FunnelStat label="KYC submission" funnel={data.behavior.kycFunnel} />
                </div>
              </>
            )}
          </Section>
        </>
      )}
    </div>
  )
}
