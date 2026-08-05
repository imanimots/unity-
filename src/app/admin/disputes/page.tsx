'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, Download } from 'lucide-react'
import { Pill, StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate } from '@/components/admin/ui'

interface AdminDisputeRow {
  id: string
  title: string
  status: string
  transactionType: 'booking' | 'order' | 'barter'
  transactionReference: string | null
  raisedByName: string | null
  assignedAdminName: string | null
  outcome: string | null
  createdAt: string
}

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  evidence: 'bg-amber-100 text-amber-700',
  under_review: 'bg-blue-100 text-blue-700',
  resolved: 'bg-green-100 text-green-700',
  closed: 'bg-[#F2EDE8] text-[#6B5B55]',
  cancelled: 'bg-[#F2EDE8] text-[#9B8B85]',
  escalated: 'bg-red-100 text-red-700',
}

export default function AdminDisputesPage() {
  const [disputes, setDisputes] = useState<AdminDisputeRow[]>([])
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
      const res = await fetch(`/api/admin/disputes?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load disputes')
      }
      const body = await res.json()
      setDisputes(body.disputes ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load disputes')
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

  const openCount = disputes.filter((d) => ['open', 'evidence', 'under_review'].includes(d.status)).length
  const resolvedCount = disputes.filter((d) => d.status === 'resolved').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Trust & Safety" title="Disputes" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total" value={disputes.length} />
        <StatCard label="Active" value={openCount} />
        <StatCard label="Resolved" value={resolvedCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Title, reference, name…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-64 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="evidence">Evidence requested</option>
          <option value="under_review">Under review</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <a href={`/api/admin/disputes?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`} className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Title', 'Transaction', 'Raised by', 'Assigned', 'Status', 'Created', ''].map((h) => (
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
              ) : disputes.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No disputes match your filters.</td></tr>
              ) : (
                disputes.map((d) => (
                  <tr key={d.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{d.title}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">
                      {d.transactionType} {d.transactionReference ?? ''}
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{d.raisedByName ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{d.assignedAdminName ?? '—'}</td>
                    <td className="px-4 py-3"><Pill value={d.status} styles={STATUS_STYLES} /></td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(d.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/disputes/${d.id}`} className={secondaryButtonClass}>Inspect</Link>
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
