'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, Download } from 'lucide-react'
import { StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate } from '@/components/admin/ui'

interface AdminSubscriptionRow {
  merchantId: string
  merchantName: string | null
  currentPlanId: string
  status: 'active' | 'pending_change' | 'cancelled'
  pendingPlanId: string | null
  pendingPlanEffectiveAt: string | null
  lastTransitionCategory: string | null
  updatedAt: string
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  pending_change: 'Pending change',
  cancelled: 'Reverting to Starter',
}

/** Unity Phase 1 -- real data, read-only monitoring. Lists merchant_subscriptions rows only (merchants who have ever changed away from the implicit Starter default); look up any other merchant directly at /admin/subscriptions/[merchantId]. */
export default function AdminSubscriptionsPage() {
  const [rows, setRows] = useState<AdminSubscriptionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [planFilter, setPlanFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (planFilter !== 'all') params.set('planId', planFilter)
      if (search.trim()) params.set('search', search.trim())
      const res = await fetch(`/api/admin/subscriptions?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load subscriptions')
      }
      const body = await res.json()
      setRows(body.subscriptions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load subscriptions')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, planFilter, search])

  useEffect(() => {
    const t = setTimeout(() => {
      load()
    }, 250)
    return () => clearTimeout(t)
  }, [load])

  const proCount = rows.filter((r) => r.currentPlanId === 'pro').length
  const eliteCount = rows.filter((r) => r.currentPlanId === 'elite').length
  const pendingCount = rows.filter((r) => r.status === 'pending_change' || r.status === 'cancelled').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Marketplace" title="Merchant Subscriptions" />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Total (non-Starter)" value={rows.length} />
        <StatCard label="Pro" value={proCount} />
        <StatCard label="Elite" value={eliteCount} />
        <StatCard label="Pending / reverting" value={pendingCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Merchant name or id…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-72 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="pending_change">Pending change</option>
          <option value="cancelled">Reverting to Starter</option>
        </select>
        <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value)} className={inputClass}>
          <option value="all">All plans</option>
          <option value="starter">Starter</option>
          <option value="pro">Pro</option>
          <option value="elite">Elite</option>
        </select>
        <a href={`/api/admin/subscriptions?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`} className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Merchant', 'Plan', 'Status', 'Pending change', 'Updated', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-[#9B8B85]">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-red-600">{error}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No subscriptions match your filters.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.merchantId} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{r.merchantName ?? r.merchantId}</td>
                    <td className="px-4 py-3 text-sm capitalize text-[#6B5B55] dark:text-[#9B8B85]">{r.currentPlanId}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{STATUS_LABELS[r.status] ?? r.status}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{r.pendingPlanId ? `${r.pendingPlanId} on ${r.pendingPlanEffectiveAt ? formatDate(r.pendingPlanEffectiveAt) : '—'}` : '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(r.updatedAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/subscriptions/${r.merchantId}`} className={secondaryButtonClass}>Inspect</Link>
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
