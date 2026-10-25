'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, AlertTriangle } from 'lucide-react'
import { Pill, ACCOUNT_STATUS_STYLES, StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate } from '@/components/admin/ui'

interface AdminMerchantRow {
  id: string
  fullName: string | null
  displayName: string | null
  role: string
  kycStatus: string
  accountStatus: string
  unityScore: number
  createdAt: string
  activeListingCount: number
  pendingOwnershipCount: number
  hasFailedPayout: boolean
  subscriptionPlanId: string
}

const KYC_STYLES: Record<string, string> = {
  none: 'bg-[#F2EDE8] text-[#6B5B55]',
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

/** A merchant is a profile/user with role='merchant'|'both' -- not a separate data model (reuses src/lib/admin/merchants-service.ts, which itself reuses `profiles`). ADMIN-CONTROL-CENTRE-BATCH-A1. */
export default function AdminMerchantsPage() {
  const [merchants, setMerchants] = useState<AdminMerchantRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [kycFilter, setKycFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (kycFilter !== 'all') params.set('kyc_status', kycFilter)
      if (statusFilter !== 'all') params.set('account_status', statusFilter)

      const res = await fetch(`/api/admin/merchants?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load merchants')
      }
      const body = await res.json()
      setMerchants(body.merchants ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load merchants')
    } finally {
      setLoading(false)
    }
  }, [search, kycFilter, statusFilter])

  useEffect(() => {
    const t = setTimeout(() => load(), 250)
    return () => clearTimeout(t)
  }, [load])

  const activeCount = merchants.filter((m) => m.accountStatus === 'active').length
  const onboardingCount = merchants.filter((m) => m.kycStatus === 'pending' || m.kycStatus === 'none').length
  const restrictedCount = merchants.filter((m) => m.accountStatus === 'restricted' || m.accountStatus === 'suspended').length
  const supplyIssueCount = merchants.filter((m) => m.pendingOwnershipCount > 0).length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Merchant Management" title="Merchants" />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Active" value={activeCount} />
        <StatCard label="Onboarding" value={onboardingCount} />
        <StatCard label="Restricted/Suspended" value={restrictedCount} />
        <StatCard label="Supply issues" value={supplyIssueCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Search name, phone, or user id…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-64 ${inputClass}`} />
        </div>
        <select value={kycFilter} onChange={(e) => setKycFilter(e.target.value)} className={inputClass}>
          <option value="all">All KYC status</option>
          <option value="none">None</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All account status</option>
          <option value="active">Active</option>
          <option value="restricted">Restricted</option>
          <option value="suspended">Suspended</option>
          <option value="erased">Erased</option>
        </select>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Name', 'KYC', 'Account status', 'Active listings', 'Pending ownership', 'Subscription', 'Joined', ''].map((h) => (
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
              ) : merchants.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No merchants match your filters.</td></tr>
              ) : (
                merchants.map((m) => (
                  <tr key={m.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{m.fullName ?? m.displayName ?? m.id.slice(0, 8)}</td>
                    <td className="px-4 py-3"><Pill value={m.kycStatus} styles={KYC_STYLES} /></td>
                    <td className="px-4 py-3"><Pill value={m.accountStatus} styles={ACCOUNT_STATUS_STYLES} /></td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{m.activeListingCount}</td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{m.pendingOwnershipCount}</td>
                    <td className="px-4 py-3 text-sm capitalize text-[#6B5B55] dark:text-[#9B8B85]">
                      {m.subscriptionPlanId}
                      {m.hasFailedPayout ? <AlertTriangle size={12} className="inline ml-1 text-red-600" aria-label="Has a failed payout" /> : null}
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(m.createdAt)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/merchants/${m.id}`} className={secondaryButtonClass}>View</Link>
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
