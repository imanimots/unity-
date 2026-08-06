'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate, formatMoney } from '@/components/admin/ui'

interface AdminAffiliateRow {
  id: string
  affiliateCode: string | null
  name: string | null
  accountStatus: string | null
  attributionCount: number
  commissionCount: number
  pendingCount: number
  paidAmount: number
  createdAt: string
}

/** Step 11 Phase 7 -- real data, replaces the former mock page. */
export default function AdminAffiliatesPage() {
  const [affiliates, setAffiliates] = useState<AdminAffiliateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      const res = await fetch(`/api/admin/affiliates?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load affiliates')
      }
      const body = await res.json()
      setAffiliates(body.affiliates ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load affiliates')
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    const t = setTimeout(() => {
      load()
    }, 250)
    return () => clearTimeout(t)
  }, [load])

  const withPendingCount = affiliates.filter((a) => a.pendingCount > 0).length
  const totalPaid = affiliates.reduce((sum, a) => sum + a.paidAmount, 0)

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Marketplace" title="Affiliates" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total affiliates" value={affiliates.length} />
        <StatCard label="With pending commissions" value={withPendingCount} />
        <StatCard label="Total paid" value={formatMoney(totalPaid)} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Name, code…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-64 ${inputClass}`} />
        </div>
        <Link href="/admin/affiliate-commissions" className={secondaryButtonClass}>
          View all commissions
        </Link>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Name', 'Code', 'Attributions', 'Commissions', 'Pending', 'Paid', 'Joined', ''].map((h) => (
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
              ) : affiliates.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No affiliates match your search.</td></tr>
              ) : (
                affiliates.map((a) => (
                  <tr key={a.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{a.name ?? '—'}</td>
                    <td className="px-4 py-3 text-sm font-mono text-[#6B5B55] dark:text-[#9B8B85]">{a.affiliateCode ?? '—'}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{a.attributionCount}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{a.commissionCount}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{a.pendingCount}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{formatMoney(a.paidAmount)}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(a.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/affiliates/${a.id}`} className={secondaryButtonClass}>Inspect</Link>
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
