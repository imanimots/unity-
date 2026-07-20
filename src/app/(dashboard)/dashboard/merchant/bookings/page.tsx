'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { MessageCircle, Check, X, Package, Clock, ChevronRight, Star, AlertTriangle } from 'lucide-react'
import { MOCK_MERCHANT_BOOKINGS } from '@/lib/mock/data'
import type { BookingStatus } from '@/types'

const STATUS_CONFIG: Record<BookingStatus, { label: string; classes: string }> = {
  pending:   { label: 'Pending',   classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  approved:  { label: 'Approved',  classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  active:    { label: 'Active',    classes: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  returned:  { label: 'Returned',  classes: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  disputed:  { label: 'Disputed',  classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  cancelled: { label: 'Cancelled', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
}

type TabId = 'all' | BookingStatus

const TABS: { id: TabId; label: string }[] = [
  { id: 'all',      label: 'All' },
  { id: 'pending',  label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'active',   label: 'Active' },
  { id: 'returned', label: 'Completed' },
]

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function MerchantBookingsPage() {
  const [tab, setTab] = useState<TabId>('all')
  const [bookings, setBookings] = useState(MOCK_MERCHANT_BOOKINGS)

  const filtered = tab === 'all' ? bookings : bookings.filter((b) => b.status === tab)

  const pendingCount = bookings.filter((b) => b.status === 'pending').length
  const activeCount  = bookings.filter((b) => b.status === 'active').length
  const earnedTotal  = bookings.filter((b) => b.status === 'returned').reduce((sum, b) => sum + b.rental_fee, 0)

  const approve = (id: string) =>
    setBookings((bs) => bs.map((b) => b.id === id ? { ...b, status: 'approved' as BookingStatus } : b))

  const decline = (id: string) =>
    setBookings((bs) => bs.map((b) => b.id === id ? { ...b, status: 'cancelled' as BookingStatus } : b))

  const markReturned = (id: string) =>
    setBookings((bs) => bs.map((b) => b.id === id ? { ...b, status: 'returned' as BookingStatus } : b))

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Page heading */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Manage Rentals</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
          Bookings
        </h1>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Pending</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-amber-500 leading-none">{pendingCount}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">Need Review</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Active</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-green-500 leading-none">{activeCount}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">Out Now</p>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Earned</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#8B1A1A] leading-none">R{earnedTotal}</div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-2">Completed</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-8 border-b border-[#F2EDE8] dark:border-[#2A1A1A] overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-3 text-[11px] font-medium uppercase tracking-[0.12em] whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-[#8B1A1A] text-[#8B1A1A]'
                : 'border-transparent text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED]'
            }`}
          >
            {t.label}
            {t.id === 'pending' && pendingCount > 0 && (
              <span className="ml-1.5 bg-amber-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Booking list */}
      {filtered.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Package size={36} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">No bookings in this category yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((booking) => {
            const sc   = STATUS_CONFIG[booking.status]
            const cover = booking.listing?.media?.[0]?.url

            return (
              <div key={booking.id} className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
                <div className="flex items-start gap-4">
                  {/* Listing thumb */}
                  <div className="w-16 h-16 rounded-xl overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
                    {cover ? (
                      <Image src={cover} alt={booking.listing.title} width={64} height={64} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-2xl">📦</div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="min-w-0">
                        <Link href={`/listings/${booking.listing_id}`} className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] hover:underline truncate block">
                          {booking.listing.title}
                        </Link>
                        <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                          Renter: <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{booking.renter.display_name ?? booking.renter.full_name}</span>
                          <span className="mx-1.5 text-[#9B8B85]">·</span>
                          Score: {booking.renter.unity_score.toFixed(1)}
                        </p>
                      </div>
                      <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium ${sc.classes}`}>{sc.label}</span>
                    </div>

                    {/* Dates + amount */}
                    <div className="flex items-center gap-4 mt-2 text-xs text-[#9B8B85]">
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        {formatDate(booking.start_date)} – {formatDate(booking.end_date)}
                        ({booking.total_days} day{booking.total_days !== 1 ? 's' : ''})
                      </span>
                      <span className="font-semibold text-[#6B5B55] dark:text-[#9B8B85]">R{booking.rental_fee} rental</span>
                    </div>
                  </div>
                </div>

                {/* Pending actions */}
                {booking.status === 'pending' && (
                  <div className="flex gap-2 mt-4 pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
                    <button
                      onClick={() => approve(booking.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold uppercase tracking-[0.08em] rounded-xl transition-colors"
                    >
                      <Check size={13} /> Approve
                    </button>
                    <button
                      onClick={() => decline(booking.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-medium uppercase tracking-[0.08em] rounded-xl hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
                    >
                      <X size={13} /> Decline
                    </button>
                    <Link
                      href={`/chat?booking=${booking.id}`}
                      className="p-2 border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl text-[#6B5B55] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
                      title="Message renter"
                    >
                      <MessageCircle size={16} />
                    </Link>
                  </div>
                )}

                {booking.status === 'active' && (
                  <div className="flex gap-2 mt-4 pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
                    <button
                      onClick={() => markReturned(booking.id)}
                      className="flex items-center gap-1.5 px-4 py-2 bg-[#8B1A1A] text-white text-xs font-semibold uppercase tracking-[0.08em] rounded-xl hover:bg-[#7A1616] transition-colors"
                    >
                      <Check size={13} /> Confirm Return
                    </button>
                    <Link
                      href={`/chat?booking=${booking.id}`}
                      className="flex items-center gap-1.5 px-4 py-2 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-medium uppercase tracking-[0.08em] rounded-xl hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
                    >
                      <MessageCircle size={13} /> Message
                    </Link>
                  </div>
                )}

                {booking.status === 'approved' && (
                  <div className="flex items-center gap-2 mt-4 pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
                    <div className="flex-1 text-xs text-[#9B8B85] flex items-center gap-1.5">
                      <Clock size={11} className="text-blue-400" />
                      Rental starts {formatDate(booking.start_date)}
                    </div>
                    <Link
                      href={`/chat?booking=${booking.id}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-medium uppercase tracking-[0.08em] rounded-lg hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
                    >
                      <MessageCircle size={13} /> Message <ChevronRight size={12} />
                    </Link>
                  </div>
                )}

                {booking.status === 'returned' && (
                  <div className="mt-4 pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
                    <div className="flex items-center justify-between text-xs mb-3">
                      <span className="text-[#9B8B85]">Deposit released · Payout processing</span>
                      <span className="font-semibold text-green-600 dark:text-green-400">+R{booking.rental_fee}</span>
                    </div>
                    <div className="flex gap-2">
                      <Link
                        href={`/dashboard/merchant/bookings/${booking.id}/review`}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-medium uppercase tracking-[0.08em] rounded-lg hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
                      >
                        <Star size={12} /> Leave Review
                      </Link>
                      <Link
                        href={`/dashboard/merchant/bookings/${booking.id}/dispute`}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-medium uppercase tracking-[0.08em] rounded-lg hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
                      >
                        <AlertTriangle size={12} /> Raise Dispute
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
