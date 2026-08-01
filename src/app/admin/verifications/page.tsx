'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, ExternalLink } from 'lucide-react'

interface QueueRow {
  userId: string
  userName: string | null
  role: string | null
  status: string
  countryOfResidence: string | null
  accountCountry: string | null
  unityScore: number | null
  submittedAt: string | null
  accountAgeDays: number | null
  reviewCount: number
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' })
}

const STATUS_STYLES: Record<string, string> = {
  not_started: 'bg-[#F2EDE8] text-[#6B5B55]',
  pending: 'bg-amber-100 text-amber-700',
  under_review: 'bg-blue-100 text-blue-700',
  additional_information_required: 'bg-orange-100 text-orange-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

function Pill({ value }: { value: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize whitespace-nowrap ${STATUS_STYLES[value] ?? 'bg-[#F2EDE8] text-[#6B5B55]'}`}>
      {value.replace(/_/g, ' ')}
    </span>
  )
}

export default function AdminVerificationsPage() {
  const [rows, setRows] = useState<QueueRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [roleFilter, setRoleFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (roleFilter !== 'all') params.set('role', roleFilter)

      const res = await fetch(`/api/admin/verifications?${params.toString()}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Could not load the verification queue')
      }
      const body = await res.json()
      setRows(body.verifications ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the verification queue')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, roleFilter])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    if (!q) return rows
    return rows.filter((r) => (r.userName ?? '').toLowerCase().includes(q) || r.userId.toLowerCase().includes(q))
  }, [rows, search])

  const pendingCount = rows.filter((r) => r.status === 'pending' || r.status === 'under_review').length
  const infoRequiredCount = rows.filter((r) => r.status === 'additional_information_required').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Identity Verification</p>
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">Verification Queue</h1>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          <span className="text-[11px] font-medium text-amber-700 uppercase tracking-[0.1em]">Manual test verification</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Pending / under review</p>
          <p className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{pendingCount}</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Info required</p>
          <p className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{infoRequiredCount}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input
            type="text"
            placeholder="Search name or user id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A] w-64"
          />
        </div>

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]">
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="under_review">Under review</option>
          <option value="additional_information_required">Info required</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>

        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]">
          <option value="all">All roles</option>
          <option value="renter">Renter</option>
          <option value="merchant">Merchant</option>
          <option value="both">Both</option>
        </select>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['User', 'Role', 'Status', 'Country', 'Unity Score', 'Submitted', 'Account age', 'Attempts', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">
                    Loading…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-sm text-red-600">
                    {error}
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">
                    No verifications match your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((row) => (
                  <tr key={row.userId} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{row.userName ?? row.userId.slice(0, 8)}</td>
                    <td className="px-4 py-3 capitalize text-sm text-[#6B5B55] dark:text-[#9B8B85]">{row.role ?? '—'}</td>
                    <td className="px-4 py-3">
                      <Pill value={row.status} />
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{row.countryOfResidence ?? row.accountCountry ?? '—'}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{row.unityScore ?? '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-[#6B5B55] dark:text-[#9B8B85]">{formatDate(row.submittedAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{row.accountAgeDays ?? '—'}d</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{row.reviewCount}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/verifications/${row.userId}`}
                        className="inline-flex items-center gap-1 bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                      >
                        <ExternalLink size={11} />
                        Review
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#0F0A0A]">
          <p className="text-xs text-[#9B8B85]">
            Showing <span className="font-medium text-[#6B5B55]">{filtered.length}</span> of <span className="font-medium text-[#6B5B55]">{rows.length}</span> submissions
          </p>
        </div>
      </div>
    </div>
  )
}
