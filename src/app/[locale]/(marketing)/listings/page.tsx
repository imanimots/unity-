import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getListingsPage } from '@/lib/data/listings'
import { getMarketplaceRequestsPage } from '@/lib/data/marketplace-requests'
import { getSkillTaskPublicPostsPage } from '@/lib/data/skill-task-posts'
import { resolveEffectiveCountry } from '@/lib/resolve-effective-country'
import { ListingCard } from '@/components/listings/listing-card'
import { RequestCard } from '@/components/listings/request-card'
import { SkillTaskPostCard } from '@/components/listings/skill-task-post-card'
import { FilterBar } from '@/components/listings/filter-bar'
import { MarketplaceModeSelectorContainer } from '@/components/listings/marketplace-mode-selector-container'
import { DirectionToggleContainer } from '@/components/listings/direction-toggle-container'
import { KindToggleContainer } from '@/components/listings/kind-toggle-container'
import type { ListingFilters } from '@/lib/data/listings'
import { Search } from 'lucide-react'
import { absoluteUrl, isMarketplaceIndexingEnabled, getMarketplaceRobotsMeta } from '@/lib/seo/config'
import { recordSearchDemandEvent } from '@/lib/subscriptions/demand-telemetry'

const TITLE = 'Browse Listings — Unity'
const DESCRIPTION = 'Find items to rent near you across South Africa.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // Controlled independently by the marketplace indexing gate, never the
  // general one — see src/lib/seo/config.ts. Always points at the bare
  // canonical path regardless of any ?q=/?category=/?sort= on the actual
  // visited URL, so query-parameter variants never create a second,
  // conflicting canonical identity for this page.
  alternates: isMarketplaceIndexingEnabled() ? { canonical: absoluteUrl('/listings') } : undefined,
  robots: getMarketplaceRobotsMeta(),
  openGraph: { title: TITLE, description: DESCRIPTION, url: absoluteUrl('/listings'), type: 'website' },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
}

interface PageProps {
  searchParams: Promise<{
    q?: string
    category?: string
    sort?: string
    maxPrice?: string
    mode?: string
    direction?: string
    kind?: string
    cursor?: string
  }>
}

const MODE_LABELS: Record<string, string> = {
  rent: 'available to rent',
  buy: 'available to buy',
  barter: 'available to barter',
  rent_to_buy: 'available to rent-to-buy',
}

export default async function ListingsPage({ searchParams }: PageProps) {
  const t = await getTranslations('marketplace')
  const tSkills = await getTranslations('skills')
  const tTasks = await getTranslations('tasks')
  const tLookingFor = await getTranslations('lookingFor')
  const tCommon = await getTranslations('common')
  const params = await searchParams
  const mode = params.mode === 'buy' || params.mode === 'barter' || params.mode === 'rent_to_buy' ? params.mode : 'rent'
  const isBarter = mode === 'barter'
  const isLookingFor = params.direction === 'looking-for'
  // Skills + Tasks under Barter -- kind is only meaningful under
  // mode=barter (D5's six-cell matrix); any other mode always behaves
  // as 'item', byte-for-byte unchanged from before this feature.
  const kind = isBarter && (params.kind === 'skill' || params.kind === 'task') ? params.kind : 'item'
  const isSkillTask = isBarter && kind !== 'item'

  const { countryId } = await resolveEffectiveCountry()

  const filters: ListingFilters = {
    query: params.q,
    category: params.category,
    sort: params.sort as ListingFilters['sort'],
    maxPrice: params.maxPrice ? Number(params.maxPrice) : undefined,
    // Barter has no listing_type of its own -- any active, unlocked
    // listing is barter-eligible (getListings() already excludes
    // barter-locked listings unconditionally), so no type filter is
    // applied for barter mode, same as before this phase. rent_to_buy
    // DOES get its own mode value -- getListings() filters it via the
    // 1:1 enabled rent_to_buy_listing_terms row, not listing_type.
    mode: isBarter ? undefined : mode,
    countryId,
  }

  const listingsPage = isLookingFor || isSkillTask
    ? { items: [], nextCursor: null }
    : await getListingsPage({ ...filters, cursor: params.cursor })
  const requestsPage = isLookingFor && !isSkillTask
    ? await getMarketplaceRequestsPage({ transactionType: mode, category: params.category, query: params.q, countryId, sort: params.sort as 'newest' | 'budget_asc' | 'budget_desc' | 'relevance', cursor: params.cursor })
    : { items: [], nextCursor: null }
  const skillTaskPage = isSkillTask
    ? await getSkillTaskPublicPostsPage(kind as 'skill' | 'task', isLookingFor ? 'looking_for' : 'available', { query: params.q, sort: params.sort as 'newest' | 'relevance', cursor: params.cursor })
    : { items: [], nextCursor: null }

  const listings = listingsPage.items
  const requests = requestsPage.items
  const skillTaskPosts = skillTaskPage.items
  const nextCursor = isSkillTask ? skillTaskPage.nextCursor : isLookingFor ? requestsPage.nextCursor : listingsPage.nextCursor

  // Aggregate demand telemetry (Section 24-27) -- fire-and-forget,
  // never awaited by the response, never touches Search Ranking's own
  // result computation above (this reads its already-final output).
  void recordSearchDemandEvent({
    mode: isBarter ? 'barter' : mode === 'rent_to_buy' ? 'rent' : mode,
    category: params.category ?? null,
    province: null,
    zeroResult: listings.length === 0 && requests.length === 0 && skillTaskPosts.length === 0,
  })

  const nextPageUrl = (() => {
    if (!nextCursor) return null
    const usp = new URLSearchParams()
    if (params.q) usp.set('q', params.q)
    if (params.category) usp.set('category', params.category)
    if (params.sort) usp.set('sort', params.sort)
    if (params.maxPrice) usp.set('maxPrice', params.maxPrice)
    if (params.mode) usp.set('mode', params.mode)
    if (params.direction) usp.set('direction', params.direction)
    if (params.kind) usp.set('kind', params.kind)
    usp.set('cursor', nextCursor)
    return `/listings?${usp.toString()}`
  })()

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen">

      {/* ── PAGE HEADER ── */}
      <section className="bg-[#FAF8F5] dark:bg-[#0F0A0A] pt-24 pb-10 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-12">

          {/* Section label */}
          <p className="section-label mb-4">{t('browseLabel')}</p>

          {/* Big heading */}
          <h1 className="section-heading font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-8">
            {t('findWhatYouNeed')}
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
                placeholder={t('searchTools')}
                className="w-full h-14 pl-14 pr-6 rounded-xl border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] placeholder-[#9B8B85] text-base focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30 focus:border-[#8B1A1A] transition-colors shadow-sm"
              />
            </form>
          </div>

          {/* Result count */}
          <p className="text-[#9B8B85] text-sm mt-4">
            {isSkillTask
              ? `${skillTaskPosts.length} ${kind}${skillTaskPosts.length !== 1 ? 's' : ''} ${isLookingFor ? 'looking for help' : 'available'}`
              : isLookingFor
              ? `${requests.length} request${requests.length !== 1 ? 's' : ''} looking to ${mode}${params.category ? ` in ${params.category}` : ''}`
              : `${listings.length} item${listings.length !== 1 ? 's' : ''} ${MODE_LABELS[mode]}${params.category ? ` in ${params.category}` : ''}`}
          </p>
        </div>
      </section>

      {/* ── FILTER ROW ── */}
      <div className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#0F0A0A]">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-12 py-4 flex flex-wrap items-center justify-between gap-4">
          <FilterBar entity={isSkillTask ? 'skill_task' : isLookingFor ? 'requests' : 'listings'} />
          <div className="flex items-center gap-3">
            {isBarter && <KindToggleContainer />}
            <DirectionToggleContainer />
            {isLookingFor && !isSkillTask && (
              <Link href="/looking-for/new" className="px-4 py-2 rounded-full text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors">
                {tLookingFor('postRequest')}
              </Link>
            )}
            {isSkillTask && (
              <Link href="/dashboard/barter/skill-task/new" className="px-4 py-2 rounded-full text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors">
                {t('postKind', { kind: kind === 'skill' ? tSkills('label') : tTasks('label') })}
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* ── MARKETPLACE MODE SELECTOR — drives ?mode=buy|rent|barter above ── */}
      <MarketplaceModeSelectorContainer />

      {/* ── RESULTS GRID ── */}
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12 py-10 lg:py-14 pb-32">
        {isSkillTask ? (
          skillTaskPosts.length === 0 ? (
            <div className="text-center py-24">
              <p className="text-5xl mb-5">🤝</p>
              <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">
                {t('noResults')}
              </h2>
              <p className="text-[#6B5B55] dark:text-[#9B8B85]">
                {isLookingFor ? t('beFirstSkillTask.lookingFor') : t('beFirstSkillTask.available')}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
              {skillTaskPosts.map((post) => (
                <SkillTaskPostCard key={post.id} post={post} />
              ))}
            </div>
          )
        ) : isLookingFor ? (
          requests.length === 0 ? (
            <div className="text-center py-24">
              <p className="text-5xl mb-5">🔍</p>
              <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">{t('noRequestsFound')}</h2>
              <p className="text-[#6B5B55] dark:text-[#9B8B85]">{t('beFirstRequest')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
              {requests.map((r) => (
                <RequestCard key={r.id} request={r} />
              ))}
            </div>
          )
        ) : listings.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-5xl mb-5">🔍</p>
            <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">
              {t('noListingsFound')}
            </h2>
            <p className="text-[#6B5B55] dark:text-[#9B8B85] mb-6">
              {t('tryAdjusting')}
            </p>
            <Link href={`/looking-for/new${params.q ? `?title=${encodeURIComponent(params.q)}` : ''}`} className="inline-block px-5 py-2.5 rounded-full text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors">
              {t('postRequestInstead')}
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-5 gap-y-8">
            {listings.map((listing, i) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                priority={i < 4}
                verifiedLabel={listing.ownership_verified ? tCommon('verified') : undefined}
              />
            ))}
          </div>
        )}

        {nextPageUrl && (
          <div className="flex justify-center mt-10">
            <Link href={nextPageUrl} className="px-6 py-3 rounded-full text-sm font-semibold border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:border-[#8B1A1A] hover:text-[#8B1A1A] transition-colors">
              Load more
            </Link>
          </div>
        )}
      </div>

    </div>
  )
}
