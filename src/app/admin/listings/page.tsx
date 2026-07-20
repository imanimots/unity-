'use client'

import { useState, useMemo } from 'react'
import { Search, Eye, Pause, Trash2, Flag } from 'lucide-react'
import { ADMIN_MOCK_LISTINGS, type AdminListing } from '@/lib/mock/admin-data'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' })
}

function StatusBadge({ status }: { status: AdminListing['status'] }) {
  const styles: Record<AdminListing['status'], string> = {
    active:  'bg-green-100 text-green-700',
    paused:  'bg-amber-100 text-amber-700',
    draft:   'bg-[#F2EDE8] text-[#6B5B55]',
    flagged: 'bg-red-100 text-red-700',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${styles[status]}`}>
      {status}
    </span>
  )
}

function CategoryPill({ category }: { category: string }) {
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">
      {category}
    </span>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-5 py-4 flex items-center gap-4">
      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${color}`} />
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">{label}</p>
        <p className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{value}</p>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminListingsPage() {
  const [listings, setListings] = useState<AdminListing[]>(ADMIN_MOCK_LISTINGS)
  const [search, setSearch]               = useState('')
  const [statusFilter, setStatusFilter]   = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')

  // ── Mutations ──
  const togglePause = (id: string) =>
    setListings(l => l.map(x => x.id === id ? { ...x, status: x.status === 'active' ? 'paused' : 'active' } : x))

  const toggleFlag = (id: string) =>
    setListings(l => l.map(x => x.id === id ? { ...x, status: x.status === 'flagged' ? 'active' : 'flagged' } : x))

  const deleteListing = (id: string) => {
    if (confirm('Delete this listing? This cannot be undone.')) {
      setListings(l => l.filter(x => x.id !== id))
    }
  }

  // ── Derived values ──
  const categories = useMemo(() => {
    const cats = Array.from(new Set(listings.map(l => l.category))).sort()
    return cats
  }, [listings])

  const filtered = useMemo(() => {
    return listings.filter(l => {
      const q = search.toLowerCase()
      if (q && !l.title.toLowerCase().includes(q) && !l.merchant_name.toLowerCase().includes(q)) return false
      if (statusFilter !== 'all' && l.status !== statusFilter) return false
      if (categoryFilter !== 'all' && l.category !== categoryFilter) return false
      return true
    })
  }, [listings, search, statusFilter, categoryFilter])

  // Reactive stats from current listings array (not filtered)
  const activeCount  = listings.filter(l => l.status === 'active').length
  const pausedCount  = listings.filter(l => l.status === 'paused').length
  const flaggedCount = listings.filter(l => l.status === 'flagged').length

  return (
    <div className="p-6 lg:p-8 space-y-6">

      {/* ── Page Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            Listing Management
          </p>
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
            Listings
          </h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A]">
            <span className="text-[11px] font-medium text-[#6B5B55] dark:text-[#9B8B85] uppercase tracking-[0.1em]">
              {listings.length} total
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-50 border border-green-200">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span className="text-[11px] font-medium text-green-700 uppercase tracking-[0.1em]">
              Active: {activeCount}
            </span>
          </div>
        </div>
      </div>

      {/* ── Stats Strip ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Active"  value={activeCount}  color="bg-green-500" />
        <StatCard label="Paused"  value={pausedCount}  color="bg-amber-400" />
        <StatCard label="Flagged" value={flaggedCount} color="bg-red-500"   />
      </div>

      {/* ── Filter Bar ── */}
      <div className="flex flex-wrap gap-3">
        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input
            type="text"
            placeholder="Search title or merchant…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A] w-60"
          />
        </div>

        {/* Status */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="draft">Draft</option>
          <option value="flagged">Flagged</option>
        </select>

        {/* Category */}
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]"
        >
          <option value="all">All Categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      {/* ── Table ── */}
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['#', 'Title', 'Merchant', 'Category', 'Status', 'Rate', 'Bookings', 'Created', 'Actions'].map(h => (
                  <th
                    key={h}
                    className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">
                    No listings match your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((listing, idx) => {
                  const truncatedTitle = listing.title.length > 40
                    ? listing.title.slice(0, 40) + '…'
                    : listing.title

                  const canTogglePause = listing.status === 'active' || listing.status === 'paused'

                  return (
                    <tr
                      key={listing.id}
                      className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0"
                    >
                      {/* # */}
                      <td className="px-4 py-3 text-xs text-[#9B8B85] font-mono">{idx + 1}</td>

                      {/* Title */}
                      <td className="px-4 py-3 min-w-[200px]">
                        <span
                          title={listing.title}
                          className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]"
                        >
                          {truncatedTitle}
                        </span>
                      </td>

                      {/* Merchant */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                          {listing.merchant_name}
                        </span>
                      </td>

                      {/* Category */}
                      <td className="px-4 py-3">
                        <CategoryPill category={listing.category} />
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <StatusBadge status={listing.status} />
                      </td>

                      {/* Rate */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">
                          R{listing.daily_rate.toLocaleString()}/day
                        </span>
                      </td>

                      {/* Bookings */}
                      <td className="px-4 py-3">
                        <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85] tabular-nums font-medium">
                          {listing.bookings_count}
                        </span>
                      </td>

                      {/* Created */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                          {formatDate(listing.created_at)}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 flex-wrap min-w-[180px]">
                          {/* Pause / Activate toggle — only for active and paused */}
                          {canTogglePause && (
                            listing.status === 'active' ? (
                              <button
                                onClick={() => togglePause(listing.id)}
                                className="inline-flex items-center gap-1 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-xs font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                              >
                                <Pause size={11} />
                                Pause
                              </button>
                            ) : (
                              <button
                                onClick={() => togglePause(listing.id)}
                                className="inline-flex items-center gap-1 bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                              >
                                <Eye size={11} />
                                Activate
                              </button>
                            )
                          )}

                          {/* Flag / Unflag */}
                          {listing.status === 'flagged' ? (
                            <button
                              onClick={() => toggleFlag(listing.id)}
                              className="inline-flex items-center gap-1 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-xs font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                            >
                              <Flag size={11} />
                              Unflag
                            </button>
                          ) : (
                            <button
                              onClick={() => toggleFlag(listing.id)}
                              className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 hover:bg-amber-200 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                            >
                              <Flag size={11} />
                              Flag
                            </button>
                          )}

                          {/* Delete */}
                          <button
                            onClick={() => deleteListing(listing.id)}
                            className="inline-flex items-center gap-1 bg-red-600 text-white hover:bg-red-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                          >
                            <Trash2 size={11} />
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer count */}
        <div className="px-4 py-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#0F0A0A]">
          <p className="text-xs text-[#9B8B85]">
            Showing <span className="font-medium text-[#6B5B55]">{filtered.length}</span> of{' '}
            <span className="font-medium text-[#6B5B55]">{listings.length}</span> listings
          </p>
        </div>
      </div>
    </div>
  )
}
