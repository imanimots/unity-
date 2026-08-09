'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, Download } from 'lucide-react'
import { StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate, formatMoney } from '@/components/admin/ui'

const ESCROW_STATUS_LABELS: Record<string, { label: string; classes: string }> = {
  pending: { label: 'Pending', classes: 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]' },
  funded: { label: 'Funded', classes: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' },
  released: { label: 'Released', classes: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' },
  refunded: { label: 'Refunded', classes: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' },
  partially_refunded: { label: 'Partially refunded', classes: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' },
  cancelled: { label: 'Cancelled', classes: 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#9B8B85]' },
  failed: { label: 'Failed', classes: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' },
}

interface AdminEscrowRow {
  id: string
  transactionType: string
  status: string
  provider: string
  principalAmount: number
  currency: string
  transactionReference: string | null
  createdAt: string
  hasUnresolvedDispute: boolean
}

/** Phase 3 -- read-only monitoring, mirrors /admin/payouts exactly. Mutating actions live only on the detail page. */
export default function AdminEscrowPage() {
  const [rows, setRows] = useState<AdminEscrowRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (search.trim()) params.set('search', search.trim())
      const res = await fetch(`/api/admin/escrow?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load escrow transactions')
      }
      const body = await res.json()
      setRows(body.escrowTransactions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load escrow transactions')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, search])

  useEffect(() => {
    const t = setTimeout(() => {
      load()
    }, 250)
    return () => clearTimeout(t)
  }, [load])

  const pendingCount = rows.filter((r) => r.status === 'pending').length
  const fundedCount = rows.filter((r) => r.status === 'funded').length
  const releasedCount = rows.filter((r) => r.status === 'released').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Marketplace" title="Secure Transactions (Escrow)" />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={rows.length} />
        <StatCard label="Pending" value={pendingCount} />
        <StatCard label="Held" value={fundedCount} />
        <StatCard label="Released" value={releasedCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Reference or id…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-72 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          {Object.entries(ESCROW_STATUS_LABELS).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <a href={`/api/admin/escrow?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`} className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Type', 'Reference', 'Amount', 'Provider', 'Status', 'Created', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-[#9B8B85]">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-red-600">{error}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No escrow transactions match your filters.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{r.transactionType}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                      {r.transactionReference ?? '—'}
                      {r.hasUnresolvedDispute && <span className="ml-2 text-[10px] uppercase text-red-600">Disputed</span>}
                    </td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{formatMoney(r.principalAmount, r.currency)}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{r.provider}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${ESCROW_STATUS_LABELS[r.status]?.classes ?? ''}`}>
                        {ESCROW_STATUS_LABELS[r.status]?.label ?? r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(r.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/escrow/${r.id}`} className={secondaryButtonClass}>Inspect</Link>
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
