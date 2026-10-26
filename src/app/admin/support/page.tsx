'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Pill, StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDateTime } from '@/components/admin/ui'
import { SUPPORT_CASE_CATEGORIES, SUPPORT_CASE_CATEGORY_LABELS, SUPPORT_CASE_STATUSES, SUPPORT_CASE_PRIORITIES } from '@/lib/support/types'

interface AdminSupportCaseRow {
  id: string
  caseNumber: string
  title: string
  category: string
  status: string
  priority: string
  customerName: string | null
  merchantName: string | null
  assignedAdminName: string | null
  createdAt: string
  updatedAt: string
}

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  in_progress: 'bg-blue-100 text-blue-700',
  waiting_on_user: 'bg-[#F2EDE8] text-[#6B5B55]',
  escalated: 'bg-red-100 text-red-700',
  resolved: 'bg-green-100 text-green-700',
  closed: 'bg-[#F2EDE8] text-[#9B8B85]',
}

const PRIORITY_STYLES: Record<string, string> = {
  low: 'bg-[#F2EDE8] text-[#6B5B55]',
  normal: 'bg-blue-50 text-blue-700',
  high: 'bg-amber-100 text-amber-700',
  urgent: 'bg-red-100 text-red-700',
}

const PAGE_SIZE = 50

export default function AdminSupportPage() {
  const [cases, setCases] = useState<AdminSupportCaseRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [unassignedOnly, setUnassignedOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const [participantUserId, setParticipantUserId] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const fromUrl = new URLSearchParams(window.location.search).get('userId')
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fromUrl) setParticipantUserId(fromUrl)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (priorityFilter !== 'all') params.set('priority', priorityFilter)
      if (categoryFilter !== 'all') params.set('category', categoryFilter)
      if (unassignedOnly) params.set('unassigned', 'true')
      if (search.trim()) params.set('search', search.trim())
      if (participantUserId) params.set('userId', participantUserId)
      params.set('offset', String(offset))
      params.set('limit', String(PAGE_SIZE))
      const res = await fetch(`/api/admin/support?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load support cases')
      }
      const body = await res.json()
      setCases(body.cases ?? [])
      setTotal(body.total ?? 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load support cases')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, priorityFilter, categoryFilter, unassignedOnly, search, participantUserId, offset])

  useEffect(() => {
    const t = setTimeout(() => {
      load()
    }, 250)
    return () => clearTimeout(t)
  }, [load])

  // Any filter change resets to the first page.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffset(0)
  }, [statusFilter, priorityFilter, categoryFilter, unassignedOnly, search, participantUserId])

  const openCount = cases.filter((c) => c.status !== 'resolved' && c.status !== 'closed').length
  const escalatedCount = cases.filter((c) => c.status === 'escalated').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Operations" title="Support" />

      {participantUserId ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
          Showing only cases involving one user ({participantUserId}).
          <button onClick={() => setParticipantUserId(null)} className="underline font-medium">Clear filter</button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total (this page)" value={total} />
        <StatCard label="Active (this page)" value={openCount} />
        <StatCard label="Escalated (this page)" value={escalatedCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Case number, title, name…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-64 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          {SUPPORT_CASE_STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className={inputClass}>
          <option value="all">All priorities</option>
          {SUPPORT_CASE_PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className={inputClass}>
          <option value="all">All categories</option>
          {SUPPORT_CASE_CATEGORIES.map((c) => (
            <option key={c} value={c}>{SUPPORT_CASE_CATEGORY_LABELS[c]}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
          <input type="checkbox" checked={unassignedOnly} onChange={(e) => setUnassignedOnly(e.target.checked)} />
          Unassigned only
        </label>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Case', 'Title', 'Category', 'Customer/Merchant', 'Priority', 'Status', 'Assigned', 'Updated', ''].map((h) => (
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
              ) : cases.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No support cases match your filters.</td></tr>
              ) : (
                cases.map((c) => (
                  <tr key={c.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-mono text-xs text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-nowrap">{c.caseNumber}</td>
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] max-w-xs truncate">{c.title}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{SUPPORT_CASE_CATEGORY_LABELS[c.category as keyof typeof SUPPORT_CASE_CATEGORY_LABELS] ?? c.category}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{c.customerName ?? c.merchantName ?? '—'}</td>
                    <td className="px-4 py-3"><Pill value={c.priority} styles={PRIORITY_STYLES} /></td>
                    <td className="px-4 py-3"><Pill value={c.status} styles={STATUS_STYLES} /></td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{c.assignedAdminName ?? 'Unassigned'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDateTime(c.updatedAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/support/${c.id}`} className={secondaryButtonClass}>Open</Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-[#9B8B85]">
        <span>{total === 0 ? '0 cases' : `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}</span>
        <div className="flex gap-2">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className={secondaryButtonClass}>Previous</button>
          <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)} className={secondaryButtonClass}>Next</button>
        </div>
      </div>
    </div>
  )
}
