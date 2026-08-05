'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, Download, AlertTriangle } from 'lucide-react'
import { Pill, StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate, formatMoney } from '@/components/admin/ui'

interface AdminOrderRow {
  id: string
  orderReference: string
  listingTitle: string | null
  buyerName: string | null
  sellerName: string | null
  status: string
  paymentStatus: string | null
  financialReadiness: string
  totalAmount: number
  currency: string
  createdAt: string
  lastLifecycleEvent: string | null
  disputed: boolean
  hasEmailFailure: boolean
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  paid: 'bg-blue-100 text-blue-700',
  shipped: 'bg-blue-100 text-blue-700',
  delivered: 'bg-green-100 text-green-700',
  disputed: 'bg-red-100 text-red-700',
  cancelled: 'bg-[#F2EDE8] text-[#9B8B85]',
}

/** Step 11 Phase 6 -- mirrors /admin/barter's exact shape (read-only monitoring, no mutating actions). */
export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<AdminOrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [disputedOnly, setDisputedOnly] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (search.trim()) params.set('search', search.trim())
      if (disputedOnly) params.set('disputed', 'true')
      const res = await fetch(`/api/admin/orders?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load orders')
      }
      const body = await res.json()
      setOrders(body.orders ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load orders')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, search, disputedOnly])

  useEffect(() => {
    const t = setTimeout(() => {
      load()
    }, 250)
    return () => clearTimeout(t)
  }, [load])

  const awaitingPaymentCount = orders.filter((o) => o.status === 'pending').length
  const inFlightCount = orders.filter((o) => ['paid', 'shipped'].includes(o.status)).length
  const disputedCount = orders.filter((o) => o.disputed).length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Marketplace" title="Orders" />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={orders.length} />
        <StatCard label="Awaiting payment" value={awaitingPaymentCount} />
        <StatCard label="In flight" value={inFlightCount} />
        <StatCard label="Disputed" value={disputedCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Reference, buyer, seller, listing…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-64 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="paid">Paid</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
          <option value="disputed">Disputed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
          <input type="checkbox" checked={disputedOnly} onChange={(e) => setDisputedOnly(e.target.checked)} />
          Disputed only
        </label>
        <a href={`/api/admin/orders?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`} className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Reference', 'Listing', 'Buyer', 'Seller', 'Status', 'Payment', 'Total', 'Created', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={9} className="px-4 py-16 text-center text-sm text-red-600">{error}</td></tr>
              ) : orders.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No orders match your filters.</td></tr>
              ) : (
                orders.map((o) => (
                  <tr key={o.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        {o.orderReference}
                        {o.hasEmailFailure && <AlertTriangle size={12} className="text-amber-600" aria-label="Email delivery failure" />}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{o.listingTitle ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{o.buyerName ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{o.sellerName ?? '—'}</td>
                    <td className="px-4 py-3"><Pill value={o.status} styles={STATUS_STYLES} /></td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{o.paymentStatus ?? '—'}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{formatMoney(o.totalAmount, o.currency)}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(o.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/orders/${o.id}`} className={secondaryButtonClass}>Inspect</Link>
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
