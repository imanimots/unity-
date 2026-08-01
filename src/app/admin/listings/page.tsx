'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, ExternalLink, Download } from 'lucide-react'

interface QueueListing {
  id: string
  title: string
  merchantId: string
  merchantName: string | null
  merchantAccountStatus: string
  category: string
  riskTier: 'low' | 'medium' | 'high'
  listingStatus: string
  moderationStatus: string
  ownershipVerificationStatus: string
  submittedAt: string
  replacementValue: number | null
  requestedDepositAmount: number | null
  ageDays: number
  bookingCount: number
}

const ACCOUNT_STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  restricted: 'bg-amber-100 text-amber-700',
  suspended: 'bg-red-100 text-red-700',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' })
}

const MODERATION_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  requires_review: 'bg-blue-100 text-blue-700',
  flagged: 'bg-red-100 text-red-700',
}

const OWNERSHIP_STYLES: Record<string, string> = {
  not_required: 'bg-[#F2EDE8] text-[#6B5B55]',
  pending: 'bg-amber-100 text-amber-700',
  under_review: 'bg-blue-100 text-blue-700',
  additional_evidence_required: 'bg-orange-100 text-orange-700',
  verified: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

const RISK_STYLES: Record<string, string> = {
  low: 'bg-green-100 text-green-700',
  medium: 'bg-amber-100 text-amber-700',
  high: 'bg-red-100 text-red-700',
}

function Pill({ value, styles }: { value: string; styles: Record<string, string> }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize whitespace-nowrap ${styles[value] ?? 'bg-[#F2EDE8] text-[#6B5B55]'}`}>
      {value.replace(/_/g, ' ')}
    </span>
  )
}

export default function AdminListingsPage() {
  const [listings, setListings] = useState<QueueListing[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [moderationFilter, setModerationFilter] = useState('all')
  const [ownershipFilter, setOwnershipFilter] = useState('all')
  const [riskFilter, setRiskFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (moderationFilter !== 'all') params.set('moderation_status', moderationFilter)
      if (riskFilter !== 'all') params.set('risk_tier', riskFilter)
      if (categoryFilter !== 'all') params.set('category', categoryFilter)

      const res = await fetch(`/api/admin/listings?${params.toString()}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Could not load the moderation queue')
      }
      const body = await res.json()
      setListings(body.listings ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the moderation queue')
    } finally {
      setLoading(false)
    }
  }, [moderationFilter, riskFilter, categoryFilter])

  useEffect(() => {
    // Initial load and re-load on filter change -- setLoading(true) runs
    // synchronously as load()'s first statement, which this lint rule
    // flags for any effect-triggered data fetch (same class of finding as
    // src/hooks/use-auth.ts / use-kyc.ts's existing, accepted baseline).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const categories = useMemo(() => Array.from(new Set(listings.map((l) => l.category))).sort(), [listings])

  const filtered = useMemo(() => {
    return listings.filter((l) => {
      const q = search.toLowerCase()
      if (q && !l.title.toLowerCase().includes(q) && !(l.merchantName ?? '').toLowerCase().includes(q)) return false
      if (ownershipFilter !== 'all' && l.ownershipVerificationStatus !== ownershipFilter) return false
      return true
    })
  }, [listings, search, ownershipFilter])

  const pendingCount = listings.filter((l) => l.moderationStatus === 'pending').length
  const requiresReviewCount = listings.filter((l) => l.moderationStatus === 'requires_review').length
  const flaggedCount = listings.filter((l) => l.moderationStatus === 'flagged').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Listing Moderation</p>
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">Moderation Queue</h1>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          <span className="text-[11px] font-medium text-amber-700 uppercase tracking-[0.1em]">Manual test verification</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Pending</p>
          <p className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{pendingCount}</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Changes requested</p>
          <p className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{requiresReviewCount}</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Flagged</p>
          <p className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{flaggedCount}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input
            type="text"
            placeholder="Search title or merchant…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A] w-60"
          />
        </div>

        <select value={moderationFilter} onChange={(e) => setModerationFilter(e.target.value)} className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]">
          <option value="all">All moderation status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="requires_review">Changes requested</option>
          <option value="flagged">Flagged</option>
        </select>

        <select value={ownershipFilter} onChange={(e) => setOwnershipFilter(e.target.value)} className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]">
          <option value="all">All ownership status</option>
          <option value="not_required">Not required</option>
          <option value="pending">Pending</option>
          <option value="under_review">Under review</option>
          <option value="additional_evidence_required">Evidence requested</option>
          <option value="verified">Verified</option>
          <option value="rejected">Rejected</option>
        </select>

        <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)} className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]">
          <option value="all">All risk tiers</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>

        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]">
          <option value="all">All categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- this downloads a CSV file, it is not a page navigation */}
        <a
          href="/api/admin/listings?format=csv"
          className="inline-flex items-center gap-1 bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
        >
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Title', 'Merchant', 'Merchant status', 'Category', 'Risk', 'Listing status', 'Moderation', 'Ownership', 'Bookings', 'Replacement value', 'Deposit', 'Submitted', 'Age', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={14} className="px-4 py-16 text-center text-sm text-[#9B8B85]">
                    Loading…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={14} className="px-4 py-16 text-center text-sm text-red-600">
                    {error}
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={14} className="px-4 py-16 text-center text-sm text-[#9B8B85]">
                    No listings match your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((listing) => {
                  const truncatedTitle = listing.title.length > 40 ? listing.title.slice(0, 40) + '…' : listing.title
                  return (
                    <tr key={listing.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                      <td className="px-4 py-3 min-w-[200px]">
                        <span title={listing.title} className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
                          {truncatedTitle}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-[#6B5B55] dark:text-[#9B8B85]">{listing.merchantName ?? listing.merchantId.slice(0, 8)}</td>
                      <td className="px-4 py-3">
                        <Pill value={listing.merchantAccountStatus} styles={ACCOUNT_STATUS_STYLES} />
                      </td>
                      <td className="px-4 py-3 capitalize text-sm text-[#6B5B55] dark:text-[#9B8B85]">{listing.category}</td>
                      <td className="px-4 py-3">
                        <Pill value={listing.riskTier} styles={RISK_STYLES} />
                      </td>
                      <td className="px-4 py-3 capitalize text-sm text-[#6B5B55] dark:text-[#9B8B85]">{listing.listingStatus}</td>
                      <td className="px-4 py-3">
                        <Pill value={listing.moderationStatus} styles={MODERATION_STYLES} />
                      </td>
                      <td className="px-4 py-3">
                        <Pill value={listing.ownershipVerificationStatus} styles={OWNERSHIP_STYLES} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{listing.bookingCount}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">
                        {listing.replacementValue ? `R${listing.replacementValue.toLocaleString()}` : '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">
                        {listing.requestedDepositAmount ? `R${listing.requestedDepositAmount.toLocaleString()}` : '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-[#6B5B55] dark:text-[#9B8B85]">{formatDate(listing.submittedAt)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{listing.ageDays}d</td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/listings/${listing.id}`}
                          className="inline-flex items-center gap-1 bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                        >
                          <ExternalLink size={11} />
                          Review
                        </Link>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#0F0A0A]">
          <p className="text-xs text-[#9B8B85]">
            Showing <span className="font-medium text-[#6B5B55]">{filtered.length}</span> of <span className="font-medium text-[#6B5B55]">{listings.length}</span> listings
          </p>
        </div>
      </div>
    </div>
  )
}
