import Image from 'next/image'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Plus, Eye, Pencil, PauseCircle, PlayCircle, MoreHorizontal, Package, ArrowLeft, AlertTriangle } from 'lucide-react'
import { IS_MOCK_MODE, MOCK_MY_LISTINGS } from '@/lib/mock/data'
import { getServerUser } from '@/lib/data/profiles'
import { getListingsByMerchant } from '@/lib/data/listings'
import type { Listing } from '@/types'

export const metadata = { title: 'My Listings — Unity' }

type StatusT = Awaited<ReturnType<typeof getTranslations<'marketplace'>>>

function statusConfig(t: StatusT): Record<string, { label: string; classes: string }> {
  return {
    active:    { label: t('listingStatus.active'),    classes: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
    paused:    { label: t('listingStatus.paused'),    classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
    draft:     { label: t('listingStatus.draft'),     classes: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
    pending:   { label: t('listingStatus.pending'),   classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
    rented:    { label: t('listingStatus.rented'),    classes: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
    suspended: { label: t('listingStatus.suspended'), classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  }
}

interface ModerationSummary {
  listing_id: string
  moderation_status: string
  rejection_reason: string | null
  moderated_at: string | null
}
interface OwnershipSummary {
  listing_id: string
  status: string
  merchant_feedback: string | null
  reviewed_at: string | null
}

/**
 * Merchant-safe status label -- combines listings.status (lifecycle) with
 * moderation_status (review verdict) and ownership verification, read
 * only from the merchant-safe views (listing_moderation_merchant_view /
 * listing_ownership_verification_merchant_view), which never expose
 * internal admin notes. See docs/ADMIN_MODERATION.md.
 */
function deriveMerchantStatus(
  listing: Listing,
  moderation: ModerationSummary | undefined,
  ownership: OwnershipSummary | undefined,
  t: StatusT
): { label: string; classes: string; feedback: string | null; canEditResubmit: boolean } {
  if (listing.status === 'draft' && moderation?.moderation_status === 'requires_review') {
    return { label: t('listingStatus.changesRequired'), classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', feedback: moderation.rejection_reason, canEditResubmit: true }
  }
  if (listing.status === 'draft' && moderation?.moderation_status === 'rejected') {
    return { label: t('listingStatus.rejectedEditResubmit'), classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', feedback: moderation.rejection_reason, canEditResubmit: true }
  }
  if (listing.status === 'pending' && moderation?.moderation_status === 'pending') {
    return { label: t('listingStatus.submittedAwaitingReview'), classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', feedback: null, canEditResubmit: false }
  }
  if (listing.status === 'pending' && moderation?.moderation_status === 'approved' && ownership && ownership.status !== 'verified' && ownership.status !== 'not_required') {
    return { label: t('listingStatus.approvedOwnershipUnderReview'), classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', feedback: ownership.merchant_feedback, canEditResubmit: false }
  }
  if (listing.status === 'pending' && moderation?.moderation_status === 'approved') {
    return { label: t('listingStatus.approvedPendingActivation'), classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', feedback: null, canEditResubmit: false }
  }
  const sc = statusConfig(t)
  const config = sc[listing.status] ?? sc.draft
  return { label: config.label, classes: config.classes, feedback: null, canEditResubmit: false }
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
  const { profile } = await getServerUser()
  if (!profile) return []
  return getListingsByMerchant(profile.id, { includeTest: true })
}

/**
 * Reads the merchant-safe views only (RLS-scoped to auth.uid(), never the
 * admin-only base tables) -- session-scoped client, no service role
 * needed here since these views already exist for exactly this purpose.
 */
async function getModerationSummaries(listingIds: string[]): Promise<{ moderation: ModerationSummary[]; ownership: OwnershipSummary[] }> {
  if (IS_MOCK_MODE || listingIds.length === 0) return { moderation: [], ownership: [] }
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return { moderation: [], ownership: [] }

  const [{ data: moderation }, { data: ownership }] = await Promise.all([
    supabase.from('listing_moderation_merchant_view').select('*').in('listing_id', listingIds),
    supabase.from('listing_ownership_verification_merchant_view').select('*').in('listing_id', listingIds),
  ])

  return { moderation: moderation ?? [], ownership: ownership ?? [] }
}

export default async function MyListingsPage() {
  const t = await getTranslations('marketplace')
  const tPage = await getTranslations('merchant.listingsPage')
  const tMerchant = await getTranslations('merchant')
  const listings = await getMyListings()
  const { moderation, ownership } = await getModerationSummaries(listings.map((l) => l.id))

  const active = listings.filter((l) => l.status === 'active').length
  const paused = listings.filter((l) => l.status === 'paused').length
  const drafts = listings.filter((l) => l.status === 'draft').length

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">

      {/* Back */}
      <div className="mb-8">
        <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> {tPage('backLabel')}
        </Link>
      </div>

      {/* Page heading + CTA */}
      <div className="flex items-start justify-between mb-12">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{tPage('eyebrow')}</p>
          <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
            {tPage('heading')}
          </h1>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-3">
            {tPage('totalCount', { count: listings.length })}
          </p>
        </div>
        <Link
          href="/dashboard/merchant/listings/new"
          className="flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors shrink-0"
        >
          <Plus size={15} /> {tMerchant('listAnItem')}
        </Link>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{tPage('activeLabel')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-green-500 leading-none">{active}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{tPage('pausedLabel')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-amber-500 leading-none">{paused}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{tPage('draftsLabel')}</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#9B8B85] leading-none">{drafts}</div>
        </div>
      </div>

      {listings.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Package size={40} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{tPage('emptyTitle')}</p>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">{tPage('emptyDesc')}</p>
          <Link
            href="/dashboard/merchant/listings/new"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors"
          >
            <Plus size={15} /> {tPage('createFirst')}
          </Link>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
          {listings.map((listing) => {
            const cover = listing.media?.[0]?.url
            const views = getMockViewCount(listing.id)
            const bookings = getMockBookingCount(listing.id)
            const modSummary = moderation.find((m) => m.listing_id === listing.id)
            const ownSummary = ownership.find((o) => o.listing_id === listing.id)
            const derived = deriveMerchantStatus(listing, modSummary, ownSummary, t)

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
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${derived.classes}`}>
                      {derived.label}
                    </span>
                  </div>
                  <div className="text-xs text-[#9B8B85] flex items-center gap-3">
                    <span>R{listing.daily_rate}{tPage('perDay')}</span>
                    <span className="text-[#F2EDE8] dark:text-[#2A1A1A]">·</span>
                    <span>{tPage('viewsCount', { count: views })}</span>
                    <span className="text-[#F2EDE8] dark:text-[#2A1A1A]">·</span>
                    <span>{tPage('bookingsCount', { count: bookings })}</span>
                  </div>
                  {derived.feedback && (
                    <div className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span>{derived.feedback}</span>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <Link
                    href={`/listings/${listing.id}`}
                    className="p-2 rounded-lg hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors"
                    title={tPage('viewListingTitle')}
                  >
                    <Eye size={16} />
                  </Link>
                  {listing.status === 'draft' || derived.canEditResubmit ? (
                    <Link
                      href={`/dashboard/merchant/listings/new?edit=${listing.id}`}
                      className="p-2 rounded-lg hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors"
                      title={derived.canEditResubmit ? tPage('editAndResubmitTitle') : tPage('continueEditingDraftTitle')}
                    >
                      <Pencil size={16} />
                    </Link>
                  ) : (
                    <button
                      disabled
                      className="p-2 rounded-lg text-[#F2EDE8] dark:text-[#2A1A1A] cursor-not-allowed"
                      title={tPage('editUnavailableTitle')}
                    >
                      <Pencil size={16} />
                    </button>
                  )}
                  {listing.status === 'active' ? (
                    <button
                      className="p-2 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20 text-[#9B8B85] hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                      title={tPage('pauseListingTitle')}
                    >
                      <PauseCircle size={16} />
                    </button>
                  ) : listing.status === 'paused' ? (
                    <button
                      className="p-2 rounded-lg hover:bg-green-50 dark:hover:bg-green-900/20 text-[#9B8B85] hover:text-green-600 dark:hover:text-green-400 transition-colors"
                      title={tPage('activateListingTitle')}
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
