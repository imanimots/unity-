'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Link2, Copy, Check, TrendingUp, Clock,
  Users, Zap, Star,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'

const MOCK_MY_REFERRALS = [
  {
    id: 'ref-1',
    listing_title: 'DJI Mavic 3 Pro Drone + ND Filters',
    rental_date: '2026-05-10',
    rental_fee: 2400,
    commission_amount: 240,
    status: 'paid' as const,
  },
  {
    id: 'ref-2',
    listing_title: 'Sony A7R V Camera + 50mm Lens',
    rental_date: '2026-05-22',
    rental_fee: 1800,
    commission_amount: 180,
    status: 'paid' as const,
  },
  {
    id: 'ref-3',
    listing_title: 'Nikon Z6 II Mirrorless Camera + 24-70mm',
    rental_date: '2026-06-03',
    rental_fee: 1200,
    commission_amount: 120,
    status: 'pending' as const,
  },
  {
    id: 'ref-4',
    listing_title: 'Campmaster 4-Person Tent + Sleeping Bags',
    rental_date: '2026-06-08',
    rental_fee: 600,
    commission_amount: 60,
    status: 'pending' as const,
  },
]

const STATUS_STYLES = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  paid:    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
}

function BecomeAffiliateCard({ onActivate, loading }: { onActivate: () => void; loading: boolean }) {
  return (
    <div className="max-w-lg mx-auto text-center py-8">
      <div className="w-20 h-20 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center mx-auto mb-8">
        <Zap size={36} className="text-[#C4511F]" />
      </div>
      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Referral Program</p>
      <h2 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-6">
        Become an Affiliate
      </h2>
      <p className="text-[#6B5B55] dark:text-[#9B8B85] mb-2 leading-relaxed">
        Earn commission on every rental you refer. Share affiliate links for any listing that accepts referrals and get paid when the booking completes.
      </p>
      <p className="text-sm text-[#9B8B85] mb-10">
        No approval needed — activate instantly and start earning today.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-10 text-center">
        {[
          { icon: <Link2 size={20} className="text-[#C4511F]" />, label: 'Share links', desc: 'for any listing that accepts affiliates' },
          { icon: <Star size={20} className="text-[#C4511F]" />, label: 'Earn commission', desc: 'on every completed booking' },
          { icon: <TrendingUp size={20} className="text-[#C4511F]" />, label: 'Track earnings', desc: 'in your affiliate dashboard' },
        ].map(({ icon, label, desc }) => (
          <div key={label} className="p-4 rounded-xl bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A]">
            <div className="flex justify-center mb-2">{icon}</div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">{label}</p>
            <p className="text-[11px] text-[#9B8B85] mt-1 leading-tight">{desc}</p>
          </div>
        ))}
      </div>

      <button
        onClick={onActivate}
        disabled={loading}
        className="inline-flex items-center gap-2 px-8 py-3.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors disabled:opacity-60"
      >
        {loading ? (
          <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Activating…</>
        ) : (
          <><Zap size={15} /> Become an Affiliate</>
        )}
      </button>
    </div>
  )
}

export default function AffiliateDashboardPage() {
  const { profile } = useAuth()
  const [activating, setActivating] = useState(false)
  const [localAffiliateCode, setLocalAffiliateCode] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem('unity_affiliate_code')
  })
  const [copied, setCopied] = useState(false)
  const [tab, setTab] = useState<'all' | 'pending' | 'paid'>('all')

  const affiliateCode = profile?.affiliate_code || localAffiliateCode
  const isAffiliate = profile?.is_affiliate || !!localAffiliateCode

  async function handleActivate() {
    setActivating(true)
    try {
      const res = await fetch('/api/affiliate/activate', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setLocalAffiliateCode(data.affiliate_code)
        if (typeof window !== 'undefined') {
          localStorage.setItem('unity_affiliate_code', data.affiliate_code)
        }
        return
      }
    } catch {
      // Supabase not available — use local mock code
    }

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const code = `AFC-${Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')}`
    setLocalAffiliateCode(code)
    if (typeof window !== 'undefined') {
      localStorage.setItem('unity_affiliate_code', code)
    }
    setActivating(false)
  }

  if (!isAffiliate) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-8">
          <Link href="/dashboard/renter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
            <ArrowLeft size={13} /> Back
          </Link>
        </div>
        <BecomeAffiliateCard onActivate={handleActivate} loading={activating} />
      </div>
    )
  }

  const handleCopyCode = async () => {
    if (!affiliateCode) return
    try {
      await navigator.clipboard.writeText(affiliateCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const filtered = tab === 'all' ? MOCK_MY_REFERRALS : MOCK_MY_REFERRALS.filter((r) => r.status === tab)
  const totalPaid = MOCK_MY_REFERRALS.filter((r) => r.status === 'paid').reduce((s, r) => s + r.commission_amount, 0)
  const totalPending = MOCK_MY_REFERRALS.filter((r) => r.status === 'pending').reduce((s, r) => s + r.commission_amount, 0)

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Back */}
      <div className="mb-8">
        <Link href="/dashboard/renter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      {/* Page heading */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Referral Program</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
          Affiliate Program
        </h1>
      </div>

      {/* Affiliate code — hero card */}
      <div className="bg-[#1A0A0A] dark:bg-[#0F0A0A] rounded-xl p-8 mb-12 border border-[#2A1A1A]">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Your Affiliate Code</p>
        <div className="text-5xl lg:text-6xl font-extrabold tracking-widest text-white leading-none mb-6">
          {affiliateCode}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCopyCode}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-semibold uppercase tracking-[0.1em] transition-colors"
          >
            {copied ? <><Check size={12} /> Copied!</> : <><Copy size={12} /> Copy Code</>}
          </button>
          <Link href="/listings" className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-white transition-colors">
            Browse listings →
          </Link>
        </div>
        <p className="text-xs text-[#6B5B55] mt-4">
          Browse listings and use the &quot;Get affiliate link&quot; button on any listing that accepts affiliates.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Total Earned</p>
            <TrendingUp size={14} className="text-green-500" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{totalPaid}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-green-600 dark:text-green-400 mt-2">Commissions paid</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Pending</p>
            <Clock size={14} className="text-amber-400" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{totalPending}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400 mt-2">Awaiting payout</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Referrals</p>
            <Users size={14} className="text-[#9B8B85]" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{MOCK_MY_REFERRALS.length}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] mt-2">Bookings referred</p>
        </div>
      </div>

      {/* Referral history */}
      <div className="mb-12">
        <div className="flex items-end justify-between mb-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Referral History</p>
          <span className="text-xs text-[#9B8B85]">Demo data — real referrals appear after schema setup</span>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 mb-6 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
          {(['all', 'pending', 'paid'] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] border-b-2 -mb-px transition-colors ${
                tab === key
                  ? 'border-[#8B1A1A] text-[#8B1A1A]'
                  : 'border-transparent text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED]'
              }`}
            >
              {key.charAt(0).toUpperCase() + key.slice(1)}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="text-center py-16">
            <Link2 size={28} className="mx-auto text-[#9B8B85] mb-3" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">No referrals in this category yet.</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-5 py-3 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85]">Listing</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] text-right">Rental fee</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] text-right">Commission</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] text-right">Status</span>
            </div>
            <div>
              {filtered.map((r) => (
                <div key={r.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-b-0 hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
                  <div>
                    <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate pr-2">{r.listing_title}</div>
                    <div className="text-xs text-[#9B8B85]">{new Date(r.rental_date).toLocaleDateString('en-ZA')}</div>
                  </div>
                  <div className="text-sm text-[#6B5B55] dark:text-[#9B8B85] text-right">R{r.rental_fee}</div>
                  <div className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] text-right">R{r.commission_amount}</div>
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
      </div>

      <p className="text-xs text-[#9B8B85] text-center">
        Commissions are paid out monthly. Questions?{' '}
        <Link href="/chat" className="underline hover:text-[#6B5B55] dark:hover:text-[#9B8B85]">Contact support</Link>
      </p>
    </div>
  )
}
