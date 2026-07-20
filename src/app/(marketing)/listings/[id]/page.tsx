import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ShieldCheck, Star, MapPin, ArrowLeft, ArrowRight, CheckCircle, UserCheck } from 'lucide-react'
import { getListing, getSimilarListings, getListingReviews, getAverageRating } from '@/lib/data/listings'
import { ImageGallery } from '@/components/listings/image-gallery'
import { BookingCard } from '@/components/listings/booking-card'
import { ListingCard } from '@/components/listings/listing-card'
import { CATEGORIES } from '@/types'
import { AffiliateCookieSetter } from '@/components/listings/affiliate-cookie-setter'
import { AffiliateButton } from '@/components/listings/affiliate-button'

const CITY_BY_MERCHANT: Record<string, string> = {
  'user-1': 'Johannesburg', 'user-2': 'Sandton',
  'user-3': 'Cape Town', 'user-4': 'Durban',
}

const CONDITION_LABEL: Record<string, string> = {
  new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair',
}

const SHIPPING_LABEL: Record<string, string> = {
  renter: 'Paid by renter', merchant: 'Free — merchant covers shipping',
  split: 'Split 50/50 between renter and merchant', negotiate: 'Negotiate with merchant',
}

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ ref?: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  const listing = await getListing(id)
  if (!listing) return { title: 'Listing not found — Unity' }
  return {
    title: `${listing.title} — Unity`,
    description: listing.description?.slice(0, 160),
  }
}

export default async function ListingDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const { ref: affiliateRef } = await searchParams
  const [listing, similar] = await Promise.all([
    getListing(id),
    getListing(id).then((l) => l ? getSimilarListings(l) : []),
  ])

  if (!listing) notFound()

  const reviews = getListingReviews(listing.id)
  const avgRating = getAverageRating(reviews)
  const city = CITY_BY_MERCHANT[listing.merchant_id] ?? 'South Africa'
  const categoryLabel = CATEGORIES.find((c) => c.id === listing.category)?.label ?? listing.category
  const categoryIcon = CATEGORIES.find((c) => c.id === listing.category)?.icon ?? '📦'
  const hasRequirements = listing.min_unity_score > 0 || listing.deposit_required || listing.requires_credit_score

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen">
      {/* Set affiliate tracking cookie if ?ref= is present */}
      {affiliateRef && <AffiliateCookieSetter affiliateRef={affiliateRef} />}

      {/* ── BACK LINK ── */}
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12 pt-8 pb-4">
        <Link
          href="/listings"
          className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors"
        >
          <ArrowLeft size={14} /> Back to listings
        </Link>
      </div>

      {/* ── HERO IMAGE ── */}
      <div className="w-full min-h-[420px] lg:min-h-[500px] aspect-[21/9] relative bg-[#F2EDE8] dark:bg-[#1A1010] overflow-hidden">
        <ImageGallery media={listing.media ?? []} title={listing.title} />
        {/* Category badge overlaid on image */}
        <div className="absolute top-5 left-6 z-10">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1A0A0A] bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-full shadow-sm">
            {categoryIcon} {categoryLabel}
          </span>
        </div>
      </div>

      {/* ── CONTENT SECTION ── */}
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12 py-10 lg:py-16">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-10 xl:gap-16">

          {/* ── LEFT COLUMN ── */}
          <div className="space-y-10">

            {/* Title block */}
            <div>
              <p className="section-label mb-3">{categoryLabel}</p>
              <h1 className="text-3xl lg:text-5xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] leading-tight mb-5">
                {listing.title}
              </h1>

              {/* Condition + rating row */}
              <div className="flex items-center gap-3 flex-wrap">
                {listing.condition && (
                  <span className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] bg-[#F2EDE8] dark:bg-[#2A1A1A] px-2.5 py-1 rounded-full">
                    {CONDITION_LABEL[listing.condition]}
                  </span>
                )}
                {listing.ownership_verified && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-2.5 py-1 rounded-full">
                    <ShieldCheck size={11} /> Ownership verified
                  </span>
                )}
                <span className="flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                  <MapPin size={13} /> {city}
                </span>
                {reviews.length > 0 && (
                  <span className="flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                    <Star size={13} className="text-amber-400 fill-amber-400" />
                    <strong className="text-[#1A0A0A] dark:text-[#F5F0ED]">{avgRating.toFixed(1)}</strong>
                    <span>({reviews.length} review{reviews.length !== 1 ? 's' : ''})</span>
                  </span>
                )}
              </div>
            </div>

            {/* Description */}
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">About this item</h2>
              <p className="text-base text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">{listing.description}</p>
            </div>

            {/* Renter requirements */}
            {hasRequirements && (
              <div>
                <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">
                  Renter Requirements
                </h2>
                <div className="rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-5 space-y-4">
                  {listing.min_unity_score > 0 && (
                    <div className="flex items-start gap-3">
                      <Star size={16} className="text-amber-500 fill-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                          Unity Score {listing.min_unity_score}+ required
                        </p>
                        <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                          Your Unity Score must be {listing.min_unity_score} or above to book this item.
                        </p>
                      </div>
                    </div>
                  )}
                  {listing.deposit_required && (
                    <div className="flex items-start gap-3">
                      <ShieldCheck size={16} className="text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                          R{listing.deposit_amount} security deposit
                        </p>
                        <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                          Held in escrow and returned when the item comes back undamaged.
                        </p>
                      </div>
                    </div>
                  )}
                  {listing.requires_credit_score && (
                    <div className="flex items-start gap-3">
                      <UserCheck size={16} className="text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                          Identity verification required
                        </p>
                        <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                          You must have completed KYC verification to rent this item.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Merchant card — horizontal, compact */}
            {listing.merchant && (
              <div>
                <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">Listed by</h2>
                <div className="flex items-center gap-4 p-4 rounded-2xl bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A]">
                  <div className="w-12 h-12 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center text-lg font-bold text-[#6B5B55] dark:text-[#9B8B85] shrink-0">
                    {listing.merchant.display_name?.[0]?.toUpperCase() ?? 'M'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                        {listing.merchant.display_name ?? listing.merchant.full_name}
                      </span>
                      {listing.merchant.kyc_status === 'approved' && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-2 py-0.5 rounded-full">
                          <ShieldCheck size={9} /> KYC Verified
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
                      <span className="flex items-center gap-1">
                        <Star size={11} className="text-amber-400 fill-amber-400" />
                        {listing.merchant.unity_score?.toFixed(1)} Unity Score
                      </span>
                      <span>
                        Member since{' '}
                        {new Date(listing.merchant.created_at).toLocaleDateString('en-ZA', {
                          month: 'short', year: 'numeric',
                        })}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Rental details */}
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">Rental Details</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { label: 'Daily rate', value: `R${listing.daily_rate}` },
                  ...(listing.weekly_rate ? [{ label: 'Weekly rate', value: `R${listing.weekly_rate}` }] : []),
                  { label: 'Minimum rental', value: `${listing.min_rental_days} day${listing.min_rental_days !== 1 ? 's' : ''}` },
                  ...(listing.insurance_amount ? [{ label: 'Insurance', value: `R${listing.insurance_amount}/day` }] : []),
                  { label: 'Shipping', value: SHIPPING_LABEL[listing.shipping_payer] },
                ].map(({ label, value }) => (
                  <div
                    key={label}
                    className="flex justify-between items-center px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm"
                  >
                    <span className="text-[#6B5B55] dark:text-[#9B8B85]">{label}</span>
                    <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Trust features */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { icon: <ShieldCheck size={18} className="text-green-500" />, title: 'Escrow protected', desc: 'Payment held until return confirmed' },
                { icon: <CheckCircle size={18} className="text-blue-500" />, title: 'Verified listing', desc: 'Ownership documents checked' },
                { icon: <Star size={18} className="text-amber-400 fill-amber-400" />, title: 'Reviewed merchant', desc: 'Rated by the Unity community' },
              ].map(({ icon, title, desc }) => (
                <div key={title} className="flex items-start gap-3 p-4 rounded-xl bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A]">
                  <div className="shrink-0 mt-0.5">{icon}</div>
                  <div>
                    <div className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{title}</div>
                    <div className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Affiliate link generator */}
            {listing.accepts_affiliates && (
              <AffiliateButton listingId={listing.id} listingTitle={listing.title} />
            )}

            {/* Reviews */}
            {reviews.length > 0 && (
              <div>
                <div className="flex items-center gap-3 mb-6">
                  <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85]">Reviews</h2>
                  <span className="flex items-center gap-1 text-sm">
                    <Star size={14} className="text-amber-400 fill-amber-400" />
                    <strong className="text-[#1A0A0A] dark:text-[#F5F0ED]">{avgRating.toFixed(1)}</strong>
                    <span className="text-[#9B8B85]">({reviews.length})</span>
                  </span>
                </div>
                <div className="space-y-5">
                  {reviews.map((review) => (
                    <div key={review.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] pb-5 last:border-0">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-8 h-8 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center text-xs font-bold text-[#6B5B55] dark:text-[#9B8B85]">
                          {review.reviewer?.display_name?.[0]?.toUpperCase() ?? '?'}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
                            {review.reviewer?.display_name ?? 'Anonymous'}
                          </div>
                          <div className="flex items-center gap-1">
                            {Array.from({ length: 5 }).map((_, i) => (
                              <Star
                                key={i}
                                size={11}
                                className={
                                  i < review.rating
                                    ? 'text-amber-400 fill-amber-400'
                                    : 'text-[#F2EDE8] dark:text-[#2A1A1A]'
                                }
                              />
                            ))}
                          </div>
                        </div>
                        <span className="ml-auto text-xs text-[#9B8B85]">
                          {new Date(review.created_at).toLocaleDateString('en-ZA', {
                            month: 'short', year: 'numeric',
                          })}
                        </span>
                      </div>
                      {review.comment && (
                        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed pl-11">
                          {review.comment}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── RIGHT COLUMN — sticky booking card ── */}
          <div className="hidden lg:block">
            <div className="sticky top-24">
              <BookingCard listing={listing} />
            </div>
          </div>
        </div>

        {/* ── SIMILAR LISTINGS ── */}
        {similar.length > 0 && (
          <div className="mt-20 pt-10 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
            <p className="section-label mb-3">You might also like</p>
            <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-8">
              Similar Listings
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {similar.map((l) => <ListingCard key={l.id} listing={l} />)}
            </div>
          </div>
        )}
      </div>

      {/* ── Mobile sticky CTA ── */}
      <div className="lg:hidden fixed bottom-16 left-0 right-0 z-40 px-4 pb-2 bg-gradient-to-t from-[#FAF8F5] dark:from-[#0F0A0A] pt-4">
        <Link
          href={`/listings/${listing.id}/book`}
          className="flex items-center justify-center gap-2 w-full py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm shadow-lg hover:bg-[#7A1616] transition-colors"
        >
          Book Now — R{listing.daily_rate}/day <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  )
}
