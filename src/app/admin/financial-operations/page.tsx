'use client'

import { useState, useEffect, useCallback } from 'react'
import { Download } from 'lucide-react'
import { Pill, StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatMoney } from '@/components/admin/ui'

interface AdminFinancialRow {
  paymentId: string
  bookingId: string | null
  bookingReference: string | null
  orderId: string | null
  orderReference: string | null
  paymentType: string
  status: string
  amount: number
  currency: string
  workflowStatus: string | null
  failureCategory: 'retryable' | 'terminal' | 'failed' | null
  failureReason: string | null
  ledgerEntryCount: number
  payoutStatus: string | null
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  authorised: 'bg-blue-100 text-blue-700',
  captured: 'bg-green-100 text-green-700',
  partially_captured: 'bg-blue-100 text-blue-700',
  released: 'bg-[#F2EDE8] text-[#6B5B55]',
  refunded: 'bg-[#F2EDE8] text-[#6B5B55]',
  partially_refunded: 'bg-[#F2EDE8] text-[#6B5B55]',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-[#F2EDE8] text-[#6B5B55]',
  expired: 'bg-red-100 text-red-700',
  chargeback: 'bg-red-100 text-red-700',
}

const FAILURE_STYLES: Record<string, string> = {
  retryable: 'bg-orange-100 text-orange-700',
  terminal: 'bg-red-100 text-red-700',
  failed: 'bg-red-100 text-red-700',
}

export default function AdminFinancialOperationsPage() {
  const [rows, setRows] = useState<AdminFinancialRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)

  // A status change always starts over from page 1 -- a cursor is only
  // ever valid as a continuation of the exact filter state it was minted
  // under (enforced server-side too, see decodeAndValidateCursor).
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      const res = await fetch(`/api/admin/financial-operations?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load financial operations')
      }
      const body = await res.json()
      setRows(body.operations ?? [])
      setNextCursor(body.nextCursor ?? null)
      setHasMore(!!body.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load financial operations')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  const loadMore = useCallback(async () => {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      params.set('cursor', nextCursor)
      const res = await fetch(`/api/admin/financial-operations?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load more financial operations')
      }
      const body = await res.json()
      setRows((prev) => [...prev, ...(body.operations ?? [])])
      setNextCursor(body.nextCursor ?? null)
      setHasMore(!!body.hasMore)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more financial operations')
    } finally {
      setLoadingMore(false)
    }
  }, [statusFilter, nextCursor])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const retryableCount = rows.filter((r) => r.failureCategory === 'retryable').length
  const terminalCount = rows.filter((r) => r.failureCategory === 'terminal').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Payments & Deposits" title="Financial Operations" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Payment records" value={rows.length} />
        <StatCard label="Retryable failures" value={retryableCount} />
        <StatCard label="Terminal failures" value={terminalCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="authorised">Authorised</option>
          <option value="captured">Captured</option>
          <option value="failed">Failed</option>
          <option value="expired">Expired</option>
          <option value="refunded">Refunded</option>
        </select>
        <a href={`/api/admin/financial-operations?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`} className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Reference', 'Type', 'Status', 'Amount', 'Workflow', 'Failure', 'Ledger entries', 'Payout'].map((h) => (
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
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No payment records match your filters.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.paymentId} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-nowrap">{r.bookingReference ?? r.orderReference ?? '—'}</td>
                    <td className="px-4 py-3 text-sm capitalize text-[#6B5B55] dark:text-[#9B8B85]">{r.paymentType.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3"><Pill value={r.status} styles={STATUS_STYLES} /></td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{formatMoney(r.amount, r.currency)}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{r.workflowStatus ?? '—'}</td>
                    <td className="px-4 py-3">{r.failureCategory ? <Pill value={r.failureCategory} styles={FAILURE_STYLES} /> : '—'}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{r.ledgerEntryCount}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{r.payoutStatus === 'not_applicable' ? 'N/A' : (r.payoutStatus ?? '—')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {hasMore && (
          <div className="flex justify-center py-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
            <button type="button" onClick={loadMore} disabled={loadingMore} className={secondaryButtonClass}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
