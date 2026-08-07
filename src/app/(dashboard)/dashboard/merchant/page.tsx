import Link from 'next/link'
import Image from 'next/image'
import { Plus, Package, DollarSign, Star, ShieldCheck, ArrowRight, Clock, CheckCircle, Users } from 'lucide-react'
import { getServerUser, MOCK_CURRENT_PROFILE } from '@/lib/data/profiles'
import { getListingsByMerchant } from '@/lib/data/listings'
import { IS_MOCK_MODE, MOCK_MY_LISTINGS, MOCK_MERCHANT_BOOKINGS } from '@/lib/mock/data'
import type { BookingStatus, ListingStatus } from '@/types'

export const metadata = { title: 'Merchant Dashboard — Unity' }

const BOOKING_STATUS_CLASSES: Record<BookingStatus, string> = {
  pending:   'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  approved:  'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  active:    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  returned:  'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  disputed:  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
}

const LISTING_STATUS_CLASSES: Record<ListingStatus, string> = {
  active:  'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  paused:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  draft:   'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  pending: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  rented:  'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })
}

export default async function MerchantDashboard() {
  const { profile: serverProfile } = await getServerUser()
  const profile = serverProfile ?? (IS_MOCK_MODE ? MOCK_CURRENT_PROFILE : null)
  const displayName = profile?.display_name ?? 'there'

  const myListings      = IS_MOCK_MODE ? MOCK_MY_LISTINGS : profile ? await getListingsByMerchant(profile.id, { includeTest: true }) : []
  const myBookings      = IS_MOCK_MODE ? MOCK_MERCHANT_BOOKINGS : []
  const activeListings  = myListings.filter((l) => l.status === 'active').length
  const pendingBookings = myBookings.filter((b) => b.status === 'pending').length
  const monthlyEarned   = myBookings.filter((b) => b.status === 'returned').reduce((s, b) => s + b.rental_fee, 0)

  const recentBookings = myBookings.slice(0, 3)
  const recentListings = myListings.slice(0, 3)

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Page heading + CTA */}
      <div className="flex items-start justify-between mb-12">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Welcome back, {displayName}</p>
          <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
            Merchant Dashboard
          </h1>
        </div>
        <Link
          href="/dashboard/merchant/listings/new"
          className="flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors shrink-0"
        >
          <Plus size={15} /> List an Item
        </Link>
      </div>

      {/* KYC banner */}
      {profile?.kyc_status !== 'approved' && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 mb-12 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ShieldCheck size={20} className="text-amber-500 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">Complete KYC to publish listings</div>
              <div className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">Identity verification is required before your first listing goes live.</div>
            </div>
          </div>
          <Link href="/verify" className="shrink-0 px-4 py-2 bg-amber-600 text-white text-xs font-semibold uppercase tracking-[0.08em] rounded-lg hover:bg-amber-700 transition-colors">
            Verify Now
          </Link>
        </div>
      )}

      {/* Earnings — featured metric */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-5">Earnings</p>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Total Earned — Completed Rentals</p>
          <div className="text-5xl lg:text-6xl font-extrabold text-[#8B1A1A] leading-none">
            R{monthlyEarned}
          </div>
          <Link href="/dashboard/merchant/payouts" className="inline-flex items-center gap-1.5 mt-4 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
            View payouts →
          </Link>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Active Listings</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{activeListings}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Pending Requests</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{pendingBookings}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Unity Score</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">
            {profile?.unity_score?.toFixed(1) ?? '5.0'}
          </div>
        </div>
      </div>

      {/* Recent Bookings */}
      <div className="mb-12">
        <div className="flex items-end justify-between mb-5">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Recent Bookings</p>
            <h2 className="text-lg font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
              Booking Requests
              {pendingBookings > 0 && (
                <span className="ml-2 bg-amber-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 align-middle">{pendingBookings}</span>
              )}
            </h2>
          </div>
          <Link href="/dashboard/merchant/bookings" className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
            View all →
          </Link>
        </div>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl">
          {recentBookings.length === 0 ? (
            <div className="text-center py-16 px-8">
              <CheckCircle size={36} className="mx-auto text-[#9B8B85] mb-4" />
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">No pending requests</p>
              <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">Create a listing to start receiving booking requests.</p>
              <Link href="/dashboard/merchant/listings/new" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors">
                <Plus size={14} /> Create Your First Listing
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-[#F2EDE8] dark:divide-[#2A1A1A]">
              {recentBookings.map((booking) => {
                const cover = booking.listing?.media?.[0]?.url
                return (
                  <div key={booking.id} className="flex items-center gap-4 px-5 py-4 hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
                    <div className="w-12 h-12 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
                      {cover ? (
                        <Image src={cover} alt={booking.listing.title} width={48} height={48} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-sm">📦</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{booking.listing.title}</p>
                      <p className="text-xs text-[#9B8B85] mt-0.5">
                        {booking.renter.display_name} · {formatDate(booking.start_date)}–{formatDate(booking.end_date)}
                      </p>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${BOOKING_STATUS_CLASSES[booking.status]}`}>
                        {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                      </span>
                      <Link href="/dashboard/merchant/bookings" className="text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
                        <ArrowRight size={16} />
                      </Link>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Your Listings */}
      <div className="mb-12">
        <div className="flex items-end justify-between mb-5">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Your Listings</p>
            <h2 className="text-lg font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">My Listings</h2>
          </div>
          <Link href="/dashboard/merchant/listings" className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
            Manage →
          </Link>
        </div>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl">
          {recentListings.length === 0 ? (
            <div className="text-center py-16 px-8">
              <Package size={36} className="mx-auto text-[#9B8B85] mb-4" />
              <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">No listings yet</p>
              <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">List an item and start earning from what you own.</p>
              <Link href="/dashboard/merchant/listings/new" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors">
                <Plus size={14} /> List an Item
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-[#F2EDE8] dark:divide-[#2A1A1A]">
              {recentListings.map((listing) => {
                const cover = listing.media?.[0]?.url
                return (
                  <div key={listing.id} className="flex items-center gap-4 px-5 py-4 hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
                    <div className="w-12 h-12 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
                      {cover ? (
                        <Image src={cover} alt={listing.title} width={48} height={48} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-sm">📦</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{listing.title}</p>
                      <p className="text-xs text-[#9B8B85] mt-0.5">R{listing.daily_rate}/day</p>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${LISTING_STATUS_CLASSES[listing.status]}`}>
                        {listing.status.charAt(0).toUpperCase() + listing.status.slice(1)}
                      </span>
                      <Link href={`/listings/${listing.id}`} className="text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
                        <ArrowRight size={16} />
                      </Link>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Quick links */}
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-5">Quick Links</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Link href="/dashboard/merchant/payouts" className="flex items-center gap-3 p-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
            <div className="w-9 h-9 rounded-xl bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
              <DollarSign size={16} className="text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Payouts</p>
              <p className="text-xs text-[#9B8B85] mt-0.5">Earnings & withdrawals</p>
            </div>
          </Link>
          <Link href="/dashboard/merchant/affiliates" className="flex items-center gap-3 p-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors">
            <div className="w-9 h-9 rounded-xl bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center shrink-0">
              <Users size={16} className="text-[#8B1A1A]" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Affiliates</p>
              <p className="text-xs text-[#9B8B85] mt-0.5">Referral commissions</p>
            </div>
          </Link>
          <Link href="/pricing" className="flex items-center gap-3 p-4 bg-[#8B1A1A] rounded-xl hover:bg-[#7A1616] transition-colors">
            <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
              <Star size={16} className="text-amber-400 fill-amber-400" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-white">Upgrade Plan</p>
              <p className="text-xs text-white/60 mt-0.5">Starter · Up to 5 listings</p>
            </div>
          </Link>
        </div>
      </div>
    </div>
  )
}
