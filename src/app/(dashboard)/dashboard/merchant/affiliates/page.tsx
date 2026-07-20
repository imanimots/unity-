'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Users, TrendingUp, AlertCircle } from 'lucide-react'
import { MOCK_AFFILIATE_REFERRALS, type AffiliateStatus } from '@/lib/mock/affiliates'

const STATUS_STYLES: Record<AffiliateStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  paid:    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
}

type TabKey = 'all' | AffiliateStatus

export default function MerchantAffiliatesPage() {
  const [tab, setTab] = useState<TabKey>('all')

  const referrals = MOCK_AFFILIATE_REFERRALS
  const filtered = tab === 'all' ? referrals : referrals.filter((r) => r.status === tab)

  const totalEarned = referrals.filter((r) => r.status === 'paid').reduce((s, r) => s + r.commission_amount, 0)
  const totalPending = referrals.filter((r) => r.status === 'pending').reduce((s, r) => s + r.commission_amount, 0)
  const uniqueAffiliates = new Set(referrals.map((r) => r.affiliate_name)).size

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'pending', label: 'Pending' },
    { key: 'paid', label: 'Paid' },
  ]

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Back */}
      <div className="mb-8">
        <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      {/* Page heading */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Referral Program</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
          Affiliates
        </h1>
      </div>

      {/* Notice */}
      <div className="flex gap-3 p-4 rounded-xl bg-[#FAF8F5] dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] mb-12">
        <AlertCircle size={16} className="text-[#9B8B85] shrink-0 mt-0.5" />
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
          For privacy, only affiliate display names are shown. Affiliate payouts are handled automatically by Unity on your behalf.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Unique Affiliates</p>
            <Users size={14} className="text-[#9B8B85]" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{uniqueAffiliates}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Commissions Paid</p>
            <TrendingUp size={14} className="text-green-500" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{totalEarned}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Commissions Pending</p>
            <TrendingUp size={14} className="text-amber-400" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{totalPending}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-8 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] border-b-2 -mb-px transition-colors ${
              tab === key
                ? 'border-[#8B1A1A] text-[#8B1A1A]'
                : 'border-transparent text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="text-center py-16">
          <Users size={28} className="mx-auto text-[#9B8B85] mb-3" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">No referrals in this category yet.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
          <div className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-x-4 px-5 py-3 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85]">Affiliate</span>
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85]">Listing</span>
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] text-right">Rental</span>
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] text-right">Commission</span>
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] text-right">Status</span>
          </div>
          <div>
            {filtered.map((r) => (
              <div key={r.id} className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-x-4 items-center px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-b-0 hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
                <div>
                  <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{r.affiliate_name}</div>
                  <div className="text-xs text-[#9B8B85]">{new Date(r.rental_date).toLocaleDateString('en-ZA')}</div>
                </div>
                <div className="text-sm text-[#6B5B55] dark:text-[#9B8B85] truncate pr-2">{r.listing_title}</div>
                <div className="text-sm text-[#6B5B55] dark:text-[#9B8B85] text-right">R{r.rental_fee}</div>
                <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] text-right">
                  {r.commission_amount > 0 ? `R${r.commission_amount}` : '—'}
                </div>
                <div className="flex justify-end">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_STYLES[r.status]}`}>
                    {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-[#9B8B85] mt-6 text-center">
        Commission rates and payout schedules are governed by your listing settings.{' '}
        <Link href="/ambassadors" className="underline hover:text-[#8B1A1A] transition-colors">Learn more about the Ambassador program →</Link>
      </p>
    </div>
  )
}
