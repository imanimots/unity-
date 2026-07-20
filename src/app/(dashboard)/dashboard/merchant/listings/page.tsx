import Link from 'next/link'
import Image from 'next/image'
import { Plus, Eye, Pencil, PauseCircle, PlayCircle, MoreHorizontal, Package, ArrowLeft } from 'lucide-react'
import { IS_MOCK_MODE, MOCK_MY_LISTINGS } from '@/lib/mock/data'
import type { Listing, ListingStatus } from '@/types'

export const metadata = { title: 'My Listings — Unity' }

const STATUS_CONFIG: Record<ListingStatus, { label: string; classes: string }> = {
  active:  { label: 'Active',  classes: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  paused:  { label: 'Paused',  classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  draft:   { label: 'Draft',   classes: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  pending: { label: 'Pending', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  rented:  { label: 'Rented',  classes: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
}

function getMockViewCount(id: string) {
  const seed = id.split('-').pop() ?? '0'
  return (parseInt(seed, 10) * 47 + 113) % 500 + 20
}

function getMockBookingCount(id: string) {
  const seed = id.split('-').pop() ?? '0'
  return (parseInt(seed, 10) * 3 + 1) % 8
}

async function getMyListings(): Promise<Listing[]> {
  if (IS_MOCK_MODE) return MOCK_MY_LISTINGS
  // TODO: fetch from Supabase filtered by auth user
  return []
}

export default async function MyListingsPage() {
  const listings = await getMyListings()

  const active = listings.filter((l) => l.status === 'active').length
  const paused = listings.filter((l) => l.status === 'paused').length
  const drafts = listings.filter((l) => l.status === 'draft').length

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Back */}
      <div className="mb-8">
        <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      {/* Page heading + CTA */}
      <div className="flex items-start justify-between mb-12">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Your Listings</p>
          <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
            My Listings
          </h1>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-3">
            {listings.length} listing{listings.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <Link
          href="/dashboard/merchant/listings/new"
          className="flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors shrink-0"
        >
          <Plus size={15} /> List an Item
        </Link>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Active</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-green-500 leading-none">{active}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Paused</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-amber-500 leading-none">{paused}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Drafts</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#9B8B85] leading-none">{drafts}</div>
        </div>
      </div>

      {listings.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Package size={40} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">No listings yet</p>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">List something you own and start earning.</p>
          <Link
            href="/dashboard/merchant/listings/new"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors"
          >
            <Plus size={15} /> Create Your First Listing
          </Link>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
          {listings.map((listing) => {
            const cover = listing.media?.[0]?.url
            const views = getMockViewCount(listing.id)
            const bookings = getMockBookingCount(listing.id)
            const sc = STATUS_CONFIG[listing.status]

            return (
              <div key={listing.id} className="flex items-center gap-4 px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-b-0 hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors group">
                {/* Thumbnail */}
                <div className="w-16 h-16 rounded-xl overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
                  {cover ? (
                    <Image src={cover} alt={listing.title} width={64} height={64} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-2xl">📦</div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] text-sm truncate">{listing.title}</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${sc.classes}`}>
                      {sc.label}
                    </span>
                  </div>
                  <div className="text-xs text-[#9B8B85] flex items-center gap-3">
                    <span>R{listing.daily_rate}/day</span>
                    <span className="text-[#F2EDE8] dark:text-[#2A1A1A]">·</span>
                    <span>{views} views</span>
                    <span className="text-[#F2EDE8] dark:text-[#2A1A1A]">·</span>
                    <span>{bookings} booking{bookings !== 1 ? 's' : ''}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <Link
                    href={`/listings/${listing.id}`}
                    className="p-2 rounded-lg hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors"
                    title="View listing"
                  >
                    <Eye size={16} />
                  </Link>
                  <Link
                    href={`/dashboard/merchant/listings/${listing.id}/edit`}
                    className="p-2 rounded-lg hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors"
                    title="Edit listing"
                  >
                    <Pencil size={16} />
                  </Link>
                  {listing.status === 'active' ? (
                    <button
                      className="p-2 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20 text-[#9B8B85] hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                      title="Pause listing"
                    >
                      <PauseCircle size={16} />
                    </button>
                  ) : listing.status === 'paused' ? (
                    <button
                      className="p-2 rounded-lg hover:bg-green-50 dark:hover:bg-green-900/20 text-[#9B8B85] hover:text-green-600 dark:hover:text-green-400 transition-colors"
                      title="Activate listing"
                    >
                      <PlayCircle size={16} />
                    </button>
                  ) : (
                    <button className="p-2 rounded-lg text-[#F2EDE8] dark:text-[#2A1A1A] cursor-default">
                      <MoreHorizontal size={16} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
