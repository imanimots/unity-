import { getListings } from '@/lib/data/listings'
import { ListingCard } from '@/components/listings/listing-card'
import { FilterBar } from '@/components/listings/filter-bar'
import type { ListingFilters } from '@/lib/data/listings'
import { Search } from 'lucide-react'

export const metadata = {
  title: 'Browse Listings — Unity',
  description: 'Find items to rent near you across South Africa.',
}

interface PageProps {
  searchParams: Promise<{
    q?: string
    category?: string
    sort?: string
    maxPrice?: string
  }>
}

export default async function ListingsPage({ searchParams }: PageProps) {
  const params = await searchParams

  const filters: ListingFilters = {
    query: params.q,
    category: params.category,
    sort: params.sort as ListingFilters['sort'],
    maxPrice: params.maxPrice ? Number(params.maxPrice) : undefined,
  }

  const listings = await getListings(filters)

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen">

      {/* ── PAGE HEADER ── */}
      <section className="bg-[#FAF8F5] dark:bg-[#0F0A0A] pt-24 pb-10 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-12">

          {/* Section label */}
          <p className="section-label mb-4">Browse Listings</p>

          {/* Big heading */}
          <h1 className="section-heading font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-8">
            Find What<br className="hidden sm:block" /> You Need.
          </h1>

          {/* Prominent search bar */}
          <div className="relative max-w-3xl">
            <Search
              size={20}
              className="absolute left-5 top-1/2 -translate-y-1/2 text-[#9B8B85] pointer-events-none"
            />
            <form method="GET">
              <input
                type="search"
                name="q"
                defaultValue={params.q ?? ''}
                placeholder="Search tools, cameras, camping gear…"
                className="w-full h-14 pl-14 pr-6 rounded-xl border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] placeholder-[#9B8B85] text-base focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30 focus:border-[#8B1A1A] transition-colors shadow-sm"
              />
            </form>
          </div>

          {/* Result count */}
          <p className="text-[#9B8B85] text-sm mt-4">
            {listings.length} item{listings.length !== 1 ? 's' : ''} available to rent
            {params.category && ` in ${params.category}`}
          </p>
        </div>
      </section>

      {/* ── FILTER ROW ── */}
      <div className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#0F0A0A]">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
          <FilterBar />
        </div>
      </div>

      {/* ── LISTING GRID ── */}
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12 py-10 lg:py-14">
        {listings.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-5xl mb-5">🔍</p>
            <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">
              No listings found
            </h2>
            <p className="text-[#6B5B55] dark:text-[#9B8B85]">
              Try adjusting your filters or search terms.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
            {listings.map((listing, i) => (
              <ListingCard key={listing.id} listing={listing} priority={i < 4} />
            ))}
          </div>
        )}
      </div>

    </div>
  )
}
