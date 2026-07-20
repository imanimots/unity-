'use client'
import { useState } from 'react'
import { Search, XCircle, Unlock } from 'lucide-react'
import { ADMIN_MOCK_BOOKINGS, type AdminBooking } from '@/lib/mock/admin-data'

type TabStatus = 'all' | 'pending' | 'active' | 'completed' | 'disputed' | 'cancelled'

const STATUS_TABS: { key: TabStatus; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
  { key: 'disputed', label: 'Disputed' },
  { key: 'cancelled', label: 'Cancelled' },
]

const STATUS_BADGE: Record<AdminBooking['status'], string> = {
  pending:   'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  active:    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  disputed:  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

function fmtDateRange(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const sMonth = monthNames[s.getMonth()]
  const eMonth = monthNames[e.getMonth()]
  if (s.getMonth() === e.getMonth()) {
    return `${sMonth} ${s.getDate()}–${e.getDate()}`
  }
  return `${sMonth} ${s.getDate()} – ${eMonth} ${e.getDate()}`
}

export default function BookingsPage() {
  const [bookings, setBookings] = useState<AdminBooking[]>(ADMIN_MOCK_BOOKINGS)
  const [selectedTab, setSelectedTab] = useState<TabStatus>('all')
  const [search, setSearch] = useState('')

  const releaseEscrow = (id: string) =>
    setBookings(b => b.map(x => x.id === id ? { ...x, status: 'completed' } : x))

  const cancelBooking = (id: string) => {
    if (window.confirm('Force cancel this booking?'))
      setBookings(b => b.map(x => x.id === id ? { ...x, status: 'cancelled' } : x))
  }

  const filtered = bookings.filter(b => {
    const matchTab = selectedTab === 'all' || b.status === selectedTab
    const q = search.toLowerCase()
    const matchSearch =
      !q ||
      b.listing_title.toLowerCase().includes(q) ||
      b.renter_name.toLowerCase().includes(q) ||
      b.merchant_name.toLowerCase().includes(q)
    return matchTab && matchSearch
  })

  const count = (s: AdminBooking['status']) => bookings.filter(b => b.status === s).length
  const totalRevenue = bookings.reduce((acc, b) => acc + b.total_amount, 0)

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* PAGE HEADER */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            Booking Management
          </p>
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-white">
            Bookings
          </h1>
        </div>
        <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1">
          {bookings.length} total
        </span>
      </div>

      {/* STATUS TABS */}
      <div className="flex gap-1 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setSelectedTab(tab.key)}
            className={`px-4 py-2.5 text-xs font-medium uppercase tracking-[0.08em] transition-colors ${
              selectedTab === tab.key
                ? 'border-b-2 border-[#8B1A1A] text-[#8B1A1A]'
                : 'text-[#6B5B55] hover:text-[#1A0A0A] dark:hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* STATS STRIP */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Pending</p>
          <p className="text-2xl font-bold text-amber-600">{count('pending')}</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Active</p>
          <p className="text-2xl font-bold text-blue-600">{count('active')}</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Completed</p>
          <p className="text-2xl font-bold text-green-600">{count('completed')}</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Disputed</p>
          <p className="text-2xl font-bold text-red-600">{count('disputed')}</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Total Revenue</p>
          <p className="text-2xl font-bold text-[#8B1A1A]">R{totalRevenue.toLocaleString()}</p>
        </div>
      </div>

      {/* SEARCH BAR */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9B8B85]" />
        <input
          type="text"
          placeholder="Search by item, renter or merchant…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-white placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30"
        />
      </div>

      {/* BOOKINGS TABLE */}
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
                {['#', 'Item', 'Renter', 'Merchant', 'Dates', 'Amount', 'Status', 'Actions'].map(h => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-[#9B8B85]">
                    No bookings found.
                  </td>
                </tr>
              ) : (
                filtered.map((booking, idx) => (
                  <tr
                    key={booking.id}
                    className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0"
                  >
                    <td className="px-4 py-3 text-sm text-[#9B8B85]">{idx + 1}</td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-[#1A0A0A] dark:text-white max-w-[160px] block truncate">
                        {booking.listing_title}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">
                      {booking.renter_name}
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">
                      {booking.merchant_name}
                    </td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">
                      {fmtDateRange(booking.start_date, booking.end_date)}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-[#1A0A0A] dark:text-white whitespace-nowrap">
                      R{booking.total_amount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[booking.status]}`}>
                        {booking.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {(booking.status === 'active' || booking.status === 'completed') && (
                          <button
                            onClick={() => releaseEscrow(booking.id)}
                            className="inline-flex items-center gap-1 border border-[#F2EDE8] text-[#6B5B55] hover:bg-[#F2EDE8] text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                          >
                            <Unlock className="w-3 h-3" />
                            Release Escrow
                          </button>
                        )}
                        {(booking.status === 'pending' || booking.status === 'active') && (
                          <button
                            onClick={() => cancelBooking(booking.id)}
                            className="inline-flex items-center gap-1 bg-red-600 text-white hover:bg-red-700 text-xs px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                          >
                            <XCircle className="w-3 h-3" />
                            Force Cancel
                          </button>
                        )}
                      </div>
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
