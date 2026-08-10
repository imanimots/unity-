'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { StatCard, AdminPageHeader, inputClass, secondaryButtonClass } from '@/components/admin/ui'

interface Row {
  id: string
  transactionType: string
  status: string
  title: string
  requesterName: string | null
  offerCount: number
  createdAt: string
}

/** Phase 4 -- narrow admin marketplace-requests surface (Step AE), read-only monitoring + close-for-abuse only. */
export default function AdminMarketplaceRequestsPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (statusFilter !== 'all') params.set('status', statusFilter)
    if (search.trim()) params.set('search', search.trim())
    const res = await fetch(`/api/admin/marketplace-requests?${params.toString()}`)
    const body = await res.json().catch(() => ({}))
    setRows(body.requests ?? [])
    setLoading(false)
  }, [statusFilter, search])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Marketplace" title="Looking For Requests" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={rows.length} />
        <StatCard label="Active" value={rows.filter((r) => r.status === 'active' || r.status === 'offers_received').length} />
        <StatCard label="Matched" value={rows.filter((r) => r.status === 'matched').length} />
        <StatCard label="Closed" value={rows.filter((r) => r.status === 'closed' || r.status === 'archived').length} />
      </div>
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title or requester…" className={`pl-8 w-72 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          {['draft', 'active', 'offers_received', 'matched', 'closed', 'date_passed', 'completed', 'archived'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Title', 'Type', 'Requester', 'Offers', 'Status', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-[#9B8B85]">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No requests match your filters.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-0">
                    <td className="px-4 py-3 text-sm font-medium">{r.title}</td>
                    <td className="px-4 py-3 text-sm capitalize">{r.transactionType}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{r.requesterName ?? '—'}</td>
                    <td className="px-4 py-3 text-sm">{r.offerCount}</td>
                    <td className="px-4 py-3 text-sm">{r.status}</td>
                    <td className="px-4 py-3"><Link href={`/admin/marketplace-requests/${r.id}`} className={secondaryButtonClass}>Inspect</Link></td>
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
