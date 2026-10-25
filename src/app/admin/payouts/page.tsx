'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, Download } from 'lucide-react'
import { StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate, formatMoney } from '@/components/admin/ui'
import { PAYOUT_STATUS_LABELS, type PayoutStatus } from '@/lib/payouts/status-labels'

interface AdminPayoutRow {
  id: string
  payoutReference: string | null
  merchantId: string
  merchantName: string | null
  bookingReference: string | null
  listingTitle: string | null
  amount: number
  currency: string
  status: PayoutStatus
  createdAt: string
  attemptCount: number
  hasUnresolvedDispute: boolean
  merchantRestricted: boolean
}

/** Step 11 Phase 8 -- real data, read-only monitoring, no mutating actions on this route. */
export default function AdminPayoutsPage() {
  const [payouts, setPayouts] = useState<AdminPayoutRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [disputeRelated, setDisputeRelated] = useState(false)
  // Merchant 360 deep-link filter -- client-side only (the underlying
  // _admin_list_merchant_payouts RPC has no merchant_id parameter, and
  // this phase is not authorized to add one via a migration). Read once
  // from the URL on mount, same pattern as the other list pages.
  const [merchantIdFilter, setMerchantIdFilter] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const fromUrl = new URLSearchParams(window.location.search).get('merchantId')
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fromUrl) setMerchantIdFilter(fromUrl)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (search.trim()) params.set('search', search.trim())
      if (overdueOnly) params.set('overdueOnly', 'true')
      if (disputeRelated) params.set('disputeRelated', 'true')
      const res = await fetch(`/api/admin/payouts?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load payouts')
      }
      const body = await res.json()
      setPayouts(body.payouts ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load payouts')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, search, overdueOnly, disputeRelated])

  useEffect(() => {
    const t = setTimeout(() => {
      load()
    }, 250)
    return () => clearTimeout(t)
  }, [load])

  const visiblePayouts = merchantIdFilter ? payouts.filter((p) => p.merchantId === merchantIdFilter) : payouts

  const pendingCount = visiblePayouts.filter((p) => p.status === 'pending').length
  const processingCount = visiblePayouts.filter((p) => p.status === 'processing').length
  const failedCount = visiblePayouts.filter((p) => p.status === 'failed').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Marketplace" title="Merchant Payouts" />

      {merchantIdFilter ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
          Showing only this merchant&apos;s payouts (client-side filter, within the current page of results).
          <button onClick={() => setMerchantIdFilter(null)} className="underline font-medium">Clear filter</button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={visiblePayouts.length} />
        <StatCard label="Pending" value={pendingCount} />
        <StatCard label="Processing" value={processingCount} />
        <StatCard label="Failed" value={failedCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Merchant, listing, booking, reference…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-72 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          {Object.entries(PAYOUT_STATUS_LABELS).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only
        </label>
        <label className="flex items-center gap-2 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
          <input type="checkbox" checked={disputeRelated} onChange={(e) => setDisputeRelated(e.target.checked)} /> Dispute-related
        </label>
        <a
          href={`/api/admin/payouts?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`}
          className={secondaryButtonClass}
        >
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Merchant', 'Listing', 'Booking', 'Amount', 'Status', 'Attempts', 'Created', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-[#9B8B85]">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-red-600">{error}</td></tr>
              ) : visiblePayouts.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No payouts match your filters.</td></tr>
              ) : (
                visiblePayouts.map((p) => (
                  <tr key={p.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
                      <Link href={`/admin/merchants/${p.merchantId}`} className="text-[#8B1A1A] underline">{p.merchantName ?? '—'}</Link>
                      {p.merchantRestricted && <span className="ml-2 text-[10px] uppercase text-red-600">Restricted</span>}
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{p.listingTitle ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                      {p.bookingReference ?? '—'}
                      {p.hasUnresolvedDispute && <span className="ml-2 text-[10px] uppercase text-red-600">Disputed</span>}
                    </td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{formatMoney(p.amount, p.currency)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${PAYOUT_STATUS_LABELS[p.status]?.classes ?? ''}`}>
                        {PAYOUT_STATUS_LABELS[p.status]?.label ?? p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{p.attemptCount}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(p.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/payouts/${p.id}`} className={secondaryButtonClass}>Inspect</Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
