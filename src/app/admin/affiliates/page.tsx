'use client'
import { useState } from 'react'
import { Search, Check, UserX, TrendingUp, Clock, Users, DollarSign } from 'lucide-react'
import { ADMIN_MOCK_AFFILIATES, ADMIN_PENDING_PAYOUTS, type AdminAffiliate, type PendingPayout } from '@/lib/mock/admin-data'

export default function AffiliatesPage() {
  const [affiliates, setAffiliates] = useState<AdminAffiliate[]>(ADMIN_MOCK_AFFILIATES)
  const [activeTab, setActiveTab] = useState<'affiliates' | 'payouts'>('affiliates')
  const [search, setSearch] = useState('')

  const markPaid = (id: string) =>
    setAffiliates(a =>
      a.map(x => x.id === id ? { ...x, paid_out: x.paid_out + x.pending_payout, pending_payout: 0 } : x)
    )

  const toggleStatus = (id: string) =>
    setAffiliates(a =>
      a.map(x => x.id === id ? { ...x, status: x.status === 'active' ? 'inactive' : 'active' } : x)
    )

  const totalAffiliates = affiliates.length
  const activeAffiliates = affiliates.filter(a => a.status === 'active').length
  const totalPaid = affiliates.reduce((sum, a) => sum + a.paid_out, 0)
  const totalPending = affiliates.reduce((sum, a) => sum + a.pending_payout, 0)

  const filteredAffiliates = affiliates.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.code.toLowerCase().includes(search.toLowerCase())
  )

  // Pending payouts list derived from current affiliate state (only those with pending > 0)
  const livePendingPayouts = ADMIN_PENDING_PAYOUTS.filter(pp => {
    const affiliate = affiliates.find(a => a.code === pp.affiliate_code)
    return affiliate && affiliate.pending_payout > 0
  })

  return (
    <div className="p-6 lg:p-8">
      {/* Page Header */}
      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
          AFFILIATE MANAGEMENT
        </p>
        <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
          AFFILIATES
        </h1>
      </div>

      {/* Stats Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Total Affiliates</p>
          </div>
          <p className="text-2xl font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{totalAffiliates}</p>
        </div>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Active Affiliates</p>
          </div>
          <p className="text-2xl font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{activeAffiliates}</p>
        </div>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Total Commission Paid</p>
          </div>
          <p className="text-2xl font-bold text-[#8B1A1A]">R{totalPaid.toLocaleString()}</p>
        </div>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Pending Payouts</p>
          </div>
          <p className="text-2xl font-bold text-amber-600">R{totalPending.toLocaleString()}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        <button
          onClick={() => setActiveTab('affiliates')}
          className={`px-4 py-2 text-xs font-medium uppercase tracking-[0.08em] border-b-2 transition-colors ${
            activeTab === 'affiliates'
              ? 'border-[#8B1A1A] text-[#8B1A1A]'
              : 'border-transparent text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED]'
          }`}
        >
          Affiliates
        </button>
        <button
          onClick={() => setActiveTab('payouts')}
          className={`px-4 py-2 text-xs font-medium uppercase tracking-[0.08em] border-b-2 transition-colors ${
            activeTab === 'payouts'
              ? 'border-[#8B1A1A] text-[#8B1A1A]'
              : 'border-transparent text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED]'
          }`}
        >
          Pending Payouts
          {livePendingPayouts.length > 0 && (
            <span className="ml-2 bg-amber-100 text-amber-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              {livePendingPayouts.length}
            </span>
          )}
        </button>
      </div>

      {/* Tab 1 — Affiliates */}
      {activeTab === 'affiliates' && (
        <div>
          {/* Search */}
          <div className="relative mb-4 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9B8B85]" />
            <input
              type="text"
              placeholder="Search by name or code…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg pl-9 pr-3 py-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:border-[#8B1A1A]"
            />
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
                    {['#', 'NAME', 'CODE', 'REFERRALS', 'EARNED', 'PENDING', 'STATUS', 'JOINED', 'ACTIONS'].map(h => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredAffiliates.map((affiliate, index) => (
                    <tr
                      key={affiliate.id}
                      className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors"
                    >
                      <td className="px-4 py-3 text-sm text-[#9B8B85]">{index + 1}</td>
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{affiliate.name}</p>
                        <p className="text-xs text-[#9B8B85]">{affiliate.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] px-2 py-1 rounded">
                          {affiliate.code}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
                        {affiliate.total_referrals}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
                        R{affiliate.total_commission.toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-sm font-medium ${affiliate.pending_payout > 0 ? 'text-amber-600' : 'text-[#9B8B85]'}`}>
                          R{affiliate.pending_payout.toLocaleString()}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`text-[11px] font-medium uppercase tracking-[0.08em] px-2 py-1 rounded-full ${
                            affiliate.status === 'active'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                          }`}
                        >
                          {affiliate.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">
                        {affiliate.joined_at}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {affiliate.pending_payout > 0 && (
                            <button
                              onClick={() => markPaid(affiliate.id)}
                              className="bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                            >
                              Mark Paid
                            </button>
                          )}
                          <button
                            onClick={() => toggleStatus(affiliate.id)}
                            className={`text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
                              affiliate.status === 'active'
                                ? 'bg-red-600 text-white hover:bg-red-700'
                                : 'border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A]'
                            }`}
                          >
                            {affiliate.status === 'active' ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredAffiliates.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-4 py-12 text-center text-sm text-[#9B8B85]">
                        No affiliates match your search.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2 — Pending Payouts */}
      {activeTab === 'payouts' && (
        <div>
          {livePendingPayouts.length === 0 ? (
            <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-16 flex flex-col items-center justify-center gap-3">
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                <Check className="w-6 h-6 text-green-600" />
              </div>
              <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">All payouts up to date</p>
              <p className="text-xs text-[#9B8B85]">No pending affiliate payouts at this time.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {livePendingPayouts.map(payout => {
                const affiliate = affiliates.find(a => a.code === payout.affiliate_code)
                return (
                  <div
                    key={payout.id}
                    className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-5 py-4 flex items-center justify-between gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                        {payout.affiliate_name}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="font-mono text-xs bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] px-2 py-0.5 rounded">
                          {payout.affiliate_code}
                        </span>
                        <span className="text-xs text-[#9B8B85]">{payout.period}</span>
                      </div>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <p className="text-xl font-bold text-[#8B1A1A]">
                        R{affiliate ? affiliate.pending_payout.toLocaleString() : payout.amount.toLocaleString()}
                      </p>
                      <p className="text-xs text-[#9B8B85]">
                        {payout.referral_count} referral{payout.referral_count !== 1 ? 's' : ''}
                      </p>
                    </div>

                    <button
                      onClick={() => affiliate && markPaid(affiliate.id)}
                      className="bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap flex-shrink-0"
                    >
                      Mark Paid
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
