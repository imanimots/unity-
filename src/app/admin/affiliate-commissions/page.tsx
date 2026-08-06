'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, Download } from 'lucide-react'
import { StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate, formatMoney } from '@/components/admin/ui'
import { AFFILIATE_COMMISSION_STATUS_LABELS, type AffiliateCommissionStatus } from '@/lib/affiliate/status-labels'

interface AdminCommissionRow {
  id: string
  transactionType: string
  status: AffiliateCommissionStatus
  affiliateName: string | null
  merchantName: string | null
  listingTitle: string | null
  reference: string | null
  commissionAmount: number
  currency: string
  createdAt: string
  hasRefundOrDispute: boolean
}

/** Step 11 Phase 7 -- real data, read-only monitoring, no mutating actions on this route. */
export default function AdminAffiliateCommissionsPage() {
  const [commissions, setCommissions] = useState<AdminCommissionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (typeFilter !== 'all') params.set('transactionType', typeFilter)
      if (search.trim()) params.set('search', search.trim())
      const res = await fetch(`/api/admin/affiliate-commissions?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load affiliate commissions')
      }
      const body = await res.json()
      setCommissions(body.commissions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load affiliate commissions')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, typeFilter, search])

  useEffect(() => {
    const t = setTimeout(() => {
      load()
    }, 250)
    return () => clearTimeout(t)
  }, [load])

  const pendingCount = commissions.filter((c) => c.status === 'pending').length
  const failedCount = commissions.filter((c) => c.status === 'failed').length
  const flaggedCount = commissions.filter((c) => c.hasRefundOrDispute).length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Marketplace" title="Affiliate Commissions" />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={commissions.length} />
        <StatCard label="Pending review" value={pendingCount} />
        <StatCard label="Payout failed" value={failedCount} />
        <StatCard label="Refund/dispute flagged" value={flaggedCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Affiliate, merchant, listing, reference…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-72 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          {Object.entries(AFFILIATE_COMMISSION_STATUS_LABELS).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={inputClass}>
          <option value="all">All transaction types</option>
          <option value="sale">Sale</option>
          <option value="rental">Rental</option>
        </select>
        <a
          href={`/api/admin/affiliate-commissions?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}${typeFilter !== 'all' ? `&transactionType=${typeFilter}` : ''}`}
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
                {['Affiliate', 'Merchant', 'Listing', 'Type', 'Amount', 'Status', 'Created', ''].map((h) => (
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
              ) : commissions.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No commissions match your filters.</td></tr>
              ) : (
                commissions.map((c) => (
                  <tr key={c.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{c.affiliateName ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{c.merchantName ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{c.listingTitle ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] capitalize">{c.transactionType}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{formatMoney(c.commissionAmount, c.currency)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${AFFILIATE_COMMISSION_STATUS_LABELS[c.status]?.classes ?? ''}`}>
                        {AFFILIATE_COMMISSION_STATUS_LABELS[c.status]?.label ?? c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(c.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/affiliate-commissions/${c.id}`} className={secondaryButtonClass}>Inspect</Link>
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
