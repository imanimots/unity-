'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, Download } from 'lucide-react'
import { Pill, StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate } from '@/components/admin/ui'

interface AdminBarterRow {
  id: string
  agreementReference: string
  status: string
  partyAName: string | null
  partyBName: string | null
  anchorListingTitle: string | null
  adminHold: boolean
  createdAt: string
}

const STATUS_STYLES: Record<string, string> = {
  proposed: 'bg-amber-100 text-amber-700',
  countered: 'bg-amber-100 text-amber-700',
  accepted: 'bg-blue-100 text-blue-700',
  preparing: 'bg-blue-100 text-blue-700',
  in_transit: 'bg-blue-100 text-blue-700',
  awaiting_confirmation: 'bg-amber-100 text-amber-700',
  completed: 'bg-green-100 text-green-700',
  rejected: 'bg-[#F2EDE8] text-[#9B8B85]',
  cancelled: 'bg-[#F2EDE8] text-[#9B8B85]',
  expired: 'bg-[#F2EDE8] text-[#9B8B85]',
  disputed: 'bg-red-100 text-red-700',
}

/** Step 11 Phase 4 Part J -- mirrors /admin/disputes' exact shape. */
export default function AdminBarterPage() {
  const [agreements, setAgreements] = useState<AdminBarterRow[]>([])
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
      const res = await fetch(`/api/admin/barter?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load barter agreements')
      }
      const body = await res.json()
      setAgreements(body.agreements ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load barter agreements')
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

  const activeCount = agreements.filter((a) => ['accepted', 'preparing', 'in_transit', 'awaiting_confirmation'].includes(a.status)).length
  const completedCount = agreements.filter((a) => a.status === 'completed').length
  const heldCount = agreements.filter((a) => a.adminHold).length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <AdminPageHeader eyebrow="Marketplace" title="Barter trades" />
        <Link href="/admin/barter/skill-task" className={secondaryButtonClass}>
          Skill/Task reports
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={agreements.length} />
        <StatCard label="Active" value={activeCount} />
        <StatCard label="Completed" value={completedCount} />
        <StatCard label="On hold" value={heldCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Reference, party, listing…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-64 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="proposed">Proposed</option>
          <option value="countered">Countered</option>
          <option value="accepted">Accepted</option>
          <option value="preparing">Preparing</option>
          <option value="in_transit">In transit</option>
          <option value="awaiting_confirmation">Awaiting confirmation</option>
          <option value="completed">Completed</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
          <option value="expired">Expired</option>
          <option value="disputed">Disputed</option>
        </select>
        <a href={`/api/admin/barter?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`} className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Listing', 'Party A', 'Party B', 'Status', 'Hold', 'Created', ''].map((h) => (
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
              ) : agreements.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No barter trades match your filters.</td></tr>
              ) : (
                agreements.map((a) => (
                  <tr key={a.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{a.anchorListingTitle ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{a.partyAName ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{a.partyBName ?? '—'}</td>
                    <td className="px-4 py-3"><Pill value={a.status} styles={STATUS_STYLES} /></td>
                    <td className="px-4 py-3 text-sm">{a.adminHold ? <span className="text-red-600 dark:text-red-400 font-medium">Held</span> : '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(a.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/barter/${a.id}`} className={secondaryButtonClass}>Inspect</Link>
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
