'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { StatCard, AdminPageHeader, inputClass, secondaryButtonClass } from '@/components/admin/ui'

interface Row {
  id: string
  status: string
  possession_status: string
  ownership_status: string
  total_purchase_price: number
  currency: string
  created_at: string
  merchant: { full_name: string | null; display_name: string | null } | null
  customer: { full_name: string | null; display_name: string | null } | null
  listing: { title: string } | null
}

export default function AdminRentToBuyPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (statusFilter !== 'all') params.set('status', statusFilter)
    if (search.trim()) params.set('search', search.trim())
    const res = await fetch(`/api/admin/rent-to-buy?${params.toString()}`)
    const body = await res.json().catch(() => ({}))
    setRows(body.agreements ?? [])
    setLoading(false)
  }, [statusFilter, search])

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [load])

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Rent-to-Buy" title="Agreements" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={rows.length} />
        <StatCard label="Active" value={rows.filter((r) => r.status === 'active').length} />
        <StatCard label="Defaulted" value={rows.filter((r) => r.status === 'defaulted').length} />
        <StatCard label="Completed" value={rows.filter((r) => r.status === 'completed').length} />
      </div>
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Item, merchant, or customer…" className={`pl-8 w-72 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          {['pending_merchant_acceptance', 'awaiting_first_payment', 'active', 'defaulted', 'return_required', 'completed', 'cancelled', 'disputed'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button onClick={load} className={secondaryButtonClass}>Refresh</button>
      </div>

      {loading ? (
        <p className="text-sm text-[#9B8B85]">Loading…</p>
      ) : (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#FAF8F5] dark:bg-[#0F0A0A] text-[10px] uppercase tracking-wide text-[#9B8B85]">
              <tr>
                <th className="text-left px-4 py-3">Item</th>
                <th className="text-left px-4 py-3">Merchant</th>
                <th className="text-left px-4 py-3">Customer</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Ownership</th>
                <th className="text-left px-4 py-3">Total</th>
                <th className="text-left px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
                  <td className="px-4 py-3">{r.listing?.title ?? '—'}</td>
                  <td className="px-4 py-3">{r.merchant?.full_name ?? r.merchant?.display_name ?? '—'}</td>
                  <td className="px-4 py-3">{r.customer?.full_name ?? r.customer?.display_name ?? '—'}</td>
                  <td className="px-4 py-3">{r.status}</td>
                  <td className="px-4 py-3">{r.ownership_status === 'merchant_owned' ? 'Merchant' : 'Customer'}</td>
                  <td className="px-4 py-3">{r.currency} {Number(r.total_purchase_price).toLocaleString()}</td>
                  <td className="px-4 py-3"><Link href={`/admin/rent-to-buy/${r.id}`} className="text-[#8B1A1A] font-semibold text-xs uppercase">Inspect</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
