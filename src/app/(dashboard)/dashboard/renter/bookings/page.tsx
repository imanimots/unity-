import Link from 'next/link'
import Image from 'next/image'
import { IS_MOCK_MODE, MOCK_RENTER_BOOKINGS } from '@/lib/mock/data'
import { Clock, Camera, AlertTriangle, MessageCircle, Star, Package, ArrowLeft } from 'lucide-react'
import type { BookingStatus } from '@/types'

export const metadata = { title: 'My Bookings — Unity' }

const STATUS_CONFIG: Record<BookingStatus, { label: string; classes: string }> = {
  pending:   { label: 'Pending approval', classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  approved:  { label: 'Approved',         classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  active:    { label: 'Active rental',    classes: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  returned:  { label: 'Completed',        classes: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  disputed:  { label: 'Disputed',         classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  cancelled: { label: 'Cancelled',        classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function RenterBookingsPage() {
  const bookings = IS_MOCK_MODE ? MOCK_RENTER_BOOKINGS : []

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Back */}
      <div className="mb-8">
        <Link href="/dashboard/renter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      {/* Page heading */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Your Bookings</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
          Bookings
        </h1>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-3">
          {bookings.length} booking{bookings.length !== 1 ? 's' : ''} total
        </p>
      </div>

      {bookings.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Package size={36} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">No bookings yet</p>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">Browse listings and make your first rental.</p>
          <Link href="/listings" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors">
            Browse Listings
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {bookings.map((b) => {
            const sc = STATUS_CONFIG[b.status]
            const cover = b.listing?.media?.[0]?.url
            const canUploadPre  = b.status === 'approved' && !b.pre_rental_media_url
            const canUploadPost = b.status === 'active' && b.pre_rental_media_url
            const canDispute    = b.status === 'active' || b.status === 'returned'
            const canChat       = b.status !== 'cancelled'

            return (
              <div key={b.id} className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
                <div className="flex items-start gap-4">
                  <div className="w-16 h-16 rounded-xl overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
                    {cover ? (
                      <Image src={cover} alt={b.listing.title} width={64} height={64} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xl">📦</div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
                      <Link href={`/listings/${b.listing_id}`} className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] hover:underline truncate">
                        {b.listing.title}
                      </Link>
                      <span className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full ${sc.classes}`}>{sc.label}</span>
                    </div>
                    <p className="text-xs text-[#9B8B85]">
                      {b.merchant?.display_name ?? b.merchant?.full_name} · {fmt(b.start_date)} – {fmt(b.end_date)} ({b.total_days}d)
                    </p>
                    <p className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">R{b.rental_fee} rental · R{b.deposit_amount} deposit</p>
                  </div>
                </div>

                {/* Media status */}
                <div className="flex gap-4 mt-4 pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
                  <span className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] ${b.pre_rental_media_url ? 'text-green-500' : 'text-[#9B8B85]'}`}>
                    <Camera size={11} /> Pre-rental {b.pre_rental_media_url ? '✓' : '—'}
                  </span>
                  <span className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] ${b.post_rental_media_url ? 'text-green-500' : 'text-[#9B8B85]'}`}>
                    <Camera size={11} /> Post-rental {b.post_rental_media_url ? '✓' : '—'}
                  </span>
                </div>

                {/* Action buttons */}
                {(canUploadPre || canUploadPost || canDispute || canChat || b.status === 'returned') && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {canUploadPre && (
                      <Link href={`/dashboard/renter/bookings/${b.id}/media`} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#8B1A1A] hover:bg-[#7A1616] text-white text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors">
                        <Camera size={12} /> Upload Pre-Rental Photos
                      </Link>
                    )}
                    {canUploadPost && (
                      <Link href={`/dashboard/renter/bookings/${b.id}/media`} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#8B1A1A] hover:bg-[#7A1616] text-white text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors">
                        <Camera size={12} /> Upload Return Photos
                      </Link>
                    )}
                    {canChat && (
                      <Link href={`/chat?booking=${b.id}`} className="flex items-center gap-1.5 px-3 py-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-medium uppercase tracking-[0.08em] rounded-lg hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
                        <MessageCircle size={12} /> Message
                      </Link>
                    )}
                    {canDispute && (
                      <Link href={`/dashboard/renter/bookings/${b.id}/dispute`} className="flex items-center gap-1.5 px-3 py-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-medium uppercase tracking-[0.08em] rounded-lg hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
                        <AlertTriangle size={12} /> Raise Dispute
                      </Link>
                    )}
                    {b.status === 'returned' && (
                      <Link href={`/dashboard/renter/bookings/${b.id}/review`} className="flex items-center gap-1.5 px-3 py-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-medium uppercase tracking-[0.08em] rounded-lg hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors">
                        <Star size={12} /> Leave Review
                      </Link>
                    )}
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
