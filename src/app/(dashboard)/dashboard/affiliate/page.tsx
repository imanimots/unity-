'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Link2, Copy, Check, TrendingUp, Clock,
  Users, Zap, Star,
} from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { AFFILIATE_COMMISSION_STATUS_LABELS, type AffiliateCommissionStatus } from '@/lib/affiliate/status-labels'

interface AffiliateListing {
  id: string
  title: string
  listing_type: 'rental' | 'sale' | 'both'
  daily_rate: number | null
  sale_price: number | null
  commission_rate: number
  thumbnail_url: string | null
}

interface AffiliateCommission {
  id: string
  transactionType: 'sale' | 'rental'
  listingTitle: string | null
  reference: string | null
  commissionAmount: number
  currency: string
  status: AffiliateCommissionStatus
  createdAt: string
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
        Earn commission on completed rentals and sales you refer, only on listings the merchant has specifically enabled. Barter trades never earn commission.
      </p>
      <p className="text-sm text-[#9B8B85] mb-10">
        No approval needed — activate instantly and start earning today.
      </p>

      <div className="grid grid-cols-3 gap-3 mb-10 text-center">
        {[
          { icon: <Link2 size={20} className="text-[#C4511F]" />, label: 'Share links', desc: 'for any listing that accepts affiliates' },
          { icon: <Star size={20} className="text-[#C4511F]" />, label: 'Earn commission', desc: 'on completed eligible sales or rentals' },
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
  const [isAffiliate, setIsAffiliate] = useState<boolean | null>(null)
  const [affiliateCode, setAffiliateCode] = useState<string | null>(null)
  const [activating, setActivating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [listings, setListings] = useState<AffiliateListing[]>([])
  const [commissions, setCommissions] = useState<AffiliateCommission[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'all' | AffiliateCommissionStatus>('all')

  const loadMe = useCallback(async () => {
    const res = await fetch('/api/affiliate/me')
    if (!res.ok) return
    const data = await res.json()
    setIsAffiliate(data.is_affiliate)
    setAffiliateCode(data.affiliate_code)
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [listingsRes, commissionsRes] = await Promise.all([fetch('/api/affiliate/listings'), fetch('/api/affiliate/commissions')])
      if (listingsRes.ok) setListings((await listingsRes.json()).listings ?? [])
      if (commissionsRes.ok) setCommissions((await commissionsRes.json()).commissions ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMe()
  }, [loadMe, profile])

  useEffect(() => {
    if (isAffiliate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadData()
    }
  }, [isAffiliate, loadData])

  async function handleActivate() {
    setActivating(true)
    try {
      const res = await fetch('/api/affiliate/activate', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setAffiliateCode(data.affiliate_code)
        setIsAffiliate(true)
      }
    } finally {
      setActivating(false)
    }
  }

  if (isAffiliate === null) {
    return <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center text-sm text-[#9B8B85]">Loading…</div>
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
    } catch {
      // ignore clipboard failures
    }
  }

  const filtered = tab === 'all' ? commissions : commissions.filter((c) => c.status === tab)
  const totalPaid = commissions.filter((c) => c.status === 'paid').reduce((sum, c) => sum + c.commissionAmount, 0)
  const totalPending = commissions
    .filter((c) => ['pending', 'held', 'approved', 'payout_queued', 'processing'].includes(c.status))
    .reduce((sum, c) => sum + c.commissionAmount, 0)

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/renter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Referral Program</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
          Affiliate Program
        </h1>
      </div>

      <div className="bg-[#1A0A0A] dark:bg-[#0F0A0A] rounded-xl p-8 mb-12 border border-[#2A1A1A]">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Your Affiliate Code</p>
        <div className="text-5xl lg:text-6xl font-extrabold tracking-widest text-white leading-none mb-6">{affiliateCode}</div>
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
          Browse affiliate-enabled listings below and copy your share link — commission is only earned on listings the merchant has enabled, and never on barter trades.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Total Paid</p>
            <TrendingUp size={14} className="text-green-500" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{totalPaid.toFixed(0)}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">In Progress</p>
            <Clock size={14} className="text-amber-400" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">R{totalPending.toFixed(0)}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Commissions</p>
            <Users size={14} className="text-[#9B8B85]" />
          </div>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{commissions.length}</div>
        </div>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Affiliate-Enabled Listings</p>
        {loading ? (
          <p className="text-sm text-[#9B8B85]">Loading…</p>
        ) : listings.length === 0 ? (
          <p className="text-sm text-[#9B8B85]">No listings currently accept affiliates.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {listings.map((l) => (
              <AffiliateListingCard key={l.id} listing={l} affiliateCode={affiliateCode} />
            ))}
          </div>
        )}
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Commission History</p>

        <div className="flex gap-0 mb-6 border-b border-[#F2EDE8] dark:border-[#2A1A1A] overflow-x-auto">
          {(['all', 'pending', 'held', 'approved', 'payout_queued', 'paid', 'failed', 'voided'] as const).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] border-b-2 -mb-px transition-colors whitespace-nowrap ${
                tab === key ? 'border-[#8B1A1A] text-[#8B1A1A]' : 'border-transparent text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED]'
              }`}
            >
              {key === 'all' ? 'All' : AFFILIATE_COMMISSION_STATUS_LABELS[key].label}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="text-center py-16">
            <Link2 size={28} className="mx-auto text-[#9B8B85] mb-3" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">No commissions in this category yet.</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-5 py-3 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85]">Listing</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] text-right">Type</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] text-right">Commission</span>
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] text-right">Status</span>
            </div>
            <div>
              {filtered.map((c) => (
                <div key={c.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-b-0 hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
                  <div>
                    <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate pr-2">{c.listingTitle ?? '—'}</div>
                    <div className="text-xs text-[#9B8B85]">{new Date(c.createdAt).toLocaleDateString('en-ZA')}</div>
                  </div>
                  <div className="text-sm text-[#6B5B55] dark:text-[#9B8B85] text-right capitalize">{c.transactionType}</div>
                  <div className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] text-right">R{c.commissionAmount.toFixed(2)}</div>
                  <div className="flex justify-end">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${AFFILIATE_COMMISSION_STATUS_LABELS[c.status].classes}`}>
                      {AFFILIATE_COMMISSION_STATUS_LABELS[c.status].label}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-[#9B8B85] text-center">
        Commissions are processed automatically after a short review period.{' '}
        <Link href="/chat" className="underline hover:text-[#6B5B55] dark:hover:text-[#9B8B85]">Contact support</Link>
      </p>
    </div>
  )
}

function AffiliateListingCard({ listing, affiliateCode }: { listing: AffiliateListing; affiliateCode: string | null }) {
  const [copied, setCopied] = useState(false)
  const link = typeof window !== 'undefined' && affiliateCode ? `${window.location.origin}/listings/${listing.id}?ref=${affiliateCode}` : ''

  const handleCopy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore clipboard failures
    }
  }

  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
      <div className="flex items-center gap-3 mb-3">
        {listing.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={listing.thumbnail_url} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{listing.title}</p>
          <p className="text-xs text-[#9B8B85]">{listing.commission_rate}% commission</p>
        </div>
      </div>
      <button
        onClick={handleCopy}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#8B1A1A] text-white text-xs font-semibold hover:bg-[#7A1616] transition-colors"
      >
        {copied ? <><Check size={13} /> Copied!</> : <><Copy size={13} /> Copy link</>}
      </button>
    </div>
  )
}
