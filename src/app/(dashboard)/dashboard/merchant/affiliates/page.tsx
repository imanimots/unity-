'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeft, Users, TrendingUp, AlertCircle } from 'lucide-react'

interface MerchantAffiliateListing {
  id: string
  title: string
  acceptsAffiliates: boolean
  commissionRate: number
  attributedCustomerCount: number
  eligibleSales: number
  eligibleRentalPayments: number
  pendingCommissionCost: number
  paidCommissionCost: number
  heldOrExceptionCount: number
}

/** Real merchant affiliate view, scoped to the caller's own listings only (Step 11 Phase 7). */
export default function MerchantAffiliatesPage() {
  const [listings, setListings] = useState<MerchantAffiliateListing[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/affiliate/merchant-listings')
      if (!res.ok) throw new Error('Could not load your listings')
      const data = await res.json()
      setListings(data.listings ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your listings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  async function toggle(listingId: string, enable: boolean) {
    setPending(listingId)
    try {
      const res = await fetch(`/api/listings/${listingId}/affiliate/${enable ? 'enable' : 'disable'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
      })
      if (res.ok) await load()
    } finally {
      setPending(null)
    }
  }

  const totalPaid = listings.reduce((sum, l) => sum + l.paidCommissionCost, 0)
  const totalPending = listings.reduce((sum, l) => sum + l.pendingCommissionCost, 0)
  const attributedTotal = listings.reduce((sum, l) => sum + l.attributedCustomerCount, 0)

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Referral Program</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">Affiliates</h1>
      </div>

      <div className="flex gap-3 p-4 rounded-xl bg-[#FAF8F5] dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] mb-12">
        <AlertCircle size={16} className="text-[#9B8B85] shrink-0 mt-0.5" />
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
          Enable affiliates per listing below. Commission is only charged on completed eligible sales or rental payments — never on deposits, refunds, or barter trades.
          Affiliate payouts are handled automatically by Unity on your behalf.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Attributed Customers</p>
            <Users size={14} className="text-[#9B8B85]" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{attributedTotal}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Commission Cost — Paid</p>
            <TrendingUp size={14} className="text-green-500" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{totalPaid.toFixed(0)}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Commission Cost — In Progress</p>
            <TrendingUp size={14} className="text-amber-400" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{totalPending.toFixed(0)}</div>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-[#9B8B85] text-center py-16">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-600 text-center py-16">{error}</p>
      ) : listings.length === 0 ? (
        <p className="text-sm text-[#9B8B85] text-center py-16">You have no listings yet.</p>
      ) : (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  {['Listing', 'Rate', 'Attributed', 'Sales', 'Rentals', 'Cost paid', 'Cost pending', 'Enabled'].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => (
                  <tr key={l.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{l.title}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{l.commissionRate}%</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{l.attributedCustomerCount}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{l.eligibleSales}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{l.eligibleRentalPayments}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">R{l.paidCommissionCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">R{l.pendingCommissionCost.toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => toggle(l.id, !l.acceptsAffiliates)}
                        disabled={pending === l.id}
                        className={`text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50 ${
                          l.acceptsAffiliates ? 'bg-green-100 text-green-700 hover:bg-red-100 hover:text-red-700' : 'border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]'
                        }`}
                      >
                        {pending === l.id ? '…' : l.acceptsAffiliates ? 'Enabled' : 'Disabled'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-[#9B8B85] mt-6 text-center">
        The commission rate for each listing is set in the listing editor.{' '}
        <Link href="/ambassadors" className="underline hover:text-[#8B1A1A] transition-colors">Learn more about the Ambassador program →</Link>
      </p>
    </div>
  )
}
