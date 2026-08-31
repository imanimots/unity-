import { notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ShieldCheck, Star, MapPin, ArrowLeft, ArrowRight, CheckCircle, UserCheck, Repeat, Wallet } from 'lucide-react'
import { getListing, getSimilarListings, getListingReviews, getAverageRating, getListingsByMerchant } from '@/lib/data/listings'
import { getRiskRequirements, RISK_TIER_LABELS } from '@/lib/risk/engine'
import { ImageGallery } from '@/components/listings/image-gallery'
import { BookingCard } from '@/components/listings/booking-card'
import { SaleSummaryCard } from '@/components/listings/sale-summary-card'
import { ListingCard } from '@/components/listings/listing-card'
import { CATEGORIES } from '@/types'
import { AffiliateCookieSetter } from '@/components/listings/affiliate-cookie-setter'
import { AffiliateAttributionRunner } from '@/components/listings/affiliate-attribution-runner'
import { AffiliateButton } from '@/components/listings/affiliate-button'
import { ProposeTradeButton } from '@/components/barter/propose-trade-button'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { ProfileLink } from '@/components/shared/profile-link'
import { isListingBarterLocked, getAllBarterLockedListingIds } from '@/lib/barter/listing-lock'
import { isListingRentToBuyLocked } from '@/lib/rent-to-buy/listing-lock'
import { getPublicRentToBuyTerms } from '@/lib/rent-to-buy/public-terms'
import { isRentToBuyEnabled } from '@/lib/rent-to-buy/config'
import { RequestRentToBuyButton } from '@/components/rent-to-buy/request-rent-to-buy-button'
import { absoluteUrl, isMarketplaceIndexingEnabled, PERMANENT_NOINDEX } from '@/lib/seo/config'
import { formatDate, formatMoneyFromRands } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { RecordListingView } from '@/components/personalization/record-listing-view'
import type { PersonalizationMode } from '@/lib/personalization/types'
import { resolveMerchantPublicIdentity } from '@/lib/subscriptions/public-identity'
import { EliteBadge } from '@/components/subscriptions/elite-badge'

const CITY_BY_MERCHANT: Record<string, string> = {
  'user-1': 'Johannesburg', 'user-2': 'Sandton',
  'user-3': 'Cape Town', 'user-4': 'Durban',
}

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ ref?: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params
  const listing = await getListing(id)
  if (!listing) return { title: 'Listing not found — Unity', robots: PERMANENT_NOINDEX }

  const title = `${listing.title} — Unity`
  const description = listing.description?.slice(0, 160)
  const image = listing.media?.[0]?.url
  const url = absoluteUrl(`/listings/${id}`)

  // A test/QA/DEMO fixture's detail page always stays noindex, regardless
  // of the marketplace flag — it's never meant to be a public search
  // result even once real listing indexing is turned on.
  const marketplaceIndexable = isMarketplaceIndexingEnabled() && !listing.is_test

  return {
    title,
    description,
    alternates: marketplaceIndexable ? { canonical: url } : undefined,
    robots: marketplaceIndexable ? { index: true, follow: true } : PERMANENT_NOINDEX,
    openGraph: { title, description, url, type: 'website', ...(image ? { images: [{ url: image }] } : {}) },
    twitter: { card: 'summary_large_image', title, description, ...(image ? { images: [image] } : {}) },
  }
}

export default async function ListingDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const { ref: affiliateRef } = await searchParams
  const tCommon = await getTranslations('common')
  const t = await getTranslations('marketplace.detail')
  const tRtb = await getTranslations('rtb')
  const locale = (await getLocale()) as Locale
  const CONDITION_LABEL: Record<string, string> = {
    new: t('condition.new'), like_new: t('condition.like_new'), good: t('condition.good'), fair: t('condition.fair'),
  }
  const SHIPPING_LABEL: Record<string, string> = {
    renter: t('shippingLabels.renter'), merchant: t('shippingLabels.merchant'),
    split: t('shippingLabels.split'), negotiate: t('shippingLabels.negotiate'),
  }
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
  const riskRequirements = getRiskRequirements(listing.risk_tier)
  const hasRequirements =
    listing.min_unity_score > 0 || listing.deposit_required || riskRequirements.ownershipVerificationRequired

  // Barter — locked listings still render their own detail page (just
  // hide Book/Buy/Propose-Trade CTAs); only the browse query excludes
  // them. See the Barter Marketplace MVP Implementation Plan, Decision 4.
  const isBarterLocked = await isListingBarterLocked(listing.id)
  const viewer = await getRequestProfile()
  const canProposeTrade = Boolean(viewer) && viewer!.userId !== listing.merchant_id && !isBarterLocked

  // Rent-to-Buy — a listing-attached transaction option (rent_to_buy_
  // listing_terms, 1:1 on listing_id), not a separate listing/duplicate
  // entity. RENT_TO_BUY_ENABLED gates the fetch itself so a disabled
  // flag never even queries RTB data (Rule 28 -- flag-off must be
  // byte-identical to before this feature existed). Locking mirrors
  // barter's own precedent exactly: an accepted RTB agreement suppresses
  // ALL transaction CTAs on this listing (Buy/Rent/Barter/RTB alike),
  // not only a new RTB request.
  const rtbTerms = isRentToBuyEnabled() ? await getPublicRentToBuyTerms(listing.id) : null
  const isRtbLocked = rtbTerms ? await isListingRentToBuyLocked(listing.id) : false
  const isCommitted = isBarterLocked || isRtbLocked
  const canRequestRtb = Boolean(rtbTerms) && !isCommitted && Boolean(viewer) && viewer!.userId !== listing.merchant_id

  let viewerListings: Awaited<ReturnType<typeof getListingsByMerchant>> = []
  let ownerListings: Awaited<ReturnType<typeof getListingsByMerchant>> = []
  if (canProposeTrade) {
    const [rawViewerListings, rawOwnerListings] = await Promise.all([
      getListingsByMerchant(viewer!.userId),
      getListingsByMerchant(listing.merchant_id),
    ])
    const lockedIds = await getAllBarterLockedListingIds()
    viewerListings = rawViewerListings.filter((l) => l.status === 'active' && !lockedIds.has(l.id))
    ownerListings = rawOwnerListings.filter((l) => l.status === 'active' && !lockedIds.has(l.id))
  }

  // Narrowly scoped nested provider (same principle as the root's public
  // message minimization) -- only BookingCard ('use client') needs
  // useTranslations() on this page; everything else here is rendered
  // server-side via getTranslations() directly and never touches this
  // provider's payload.
  const messages = await getMessages()
  const scoped = { rent: { bookingCard: messages.rent.bookingCard }, rtb: messages.rtb }

  const personalizationMode: PersonalizationMode | null =
    listing.listing_type === 'sale' ? 'buy' : listing.listing_type === 'rental' ? 'rent' : null

  return (
    <NextIntlClientProvider messages={scoped}>
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen">
      {isPersonalizationEnabled() && (
        <RecordListingView
          personalizationEnabled
          isSignedIn={Boolean(viewer)}
          listingId={listing.id}
          mode={personalizationMode}
          category={listing.category}
          province={listing.province ?? null}
          city={listing.city ?? null}
        />
      )}
      {/* Set affiliate tracking cookie if ?ref= is present */}
      {affiliateRef && <AffiliateCookieSetter listingId={listing.id} affiliateRef={affiliateRef} />}
      {/* Persist attribution the moment an authenticated visitor with a
          valid, not-yet-consumed referral cookie entry views this listing
          -- fires for a visitor who was already signed in when they
          clicked the link, and for a returning visitor who has since
          signed in. */}
      <AffiliateAttributionRunner listingId={listing.id} isSignedIn={Boolean(viewer)} />

      {/* ── BACK LINK ── */}
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12 pt-8 pb-4">
        <Link
          href="/listings"
          className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors"
        >
          <ArrowLeft size={14} /> {t('backToListings')}
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
                    <ShieldCheck size={11} /> {t('ownershipVerified')}
                  </span>
                )}
                <span className="flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                  <MapPin size={13} /> {city}
                </span>
                {reviews.length > 0 && (
                  <span className="flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                    <Star size={13} className="text-amber-400 fill-amber-400" />
                    <strong className="text-[#1A0A0A] dark:text-[#F5F0ED]">{avgRating.toFixed(1)}</strong>
                    <span>({t('reviewCount', { count: reviews.length })})</span>
                  </span>
                )}
              </div>
            </div>

            {/* Description */}
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">{t('aboutThisItem')}</h2>
              <p className="text-base text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">{listing.description}</p>
            </div>

            {/* Renter requirements */}
            {hasRequirements && (
              <div>
                <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">
                  {t('renterRequirements')}
                </h2>
                <div className="rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-5 space-y-4">
                  <div className="flex items-start gap-3">
                    <ShieldCheck size={16} className="text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                        {t('riskTierItem', { tier: RISK_TIER_LABELS[listing.risk_tier] })}
                      </p>
                      <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                        {t('riskTierDesc')}
                      </p>
                    </div>
                  </div>
                  {listing.min_unity_score > 0 && (
                    <div className="flex items-start gap-3">
                      <Star size={16} className="text-amber-500 fill-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                          {t('unityScoreRequired', { score: listing.min_unity_score })}
                        </p>
                        <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                          {t('unityScoreDesc', { score: listing.min_unity_score })}
                        </p>
                      </div>
                    </div>
                  )}
                  {listing.deposit_required && (
                    <div className="flex items-start gap-3">
                      <ShieldCheck size={16} className="text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                          {t('securityDeposit', { amount: formatMoneyFromRands(listing.deposit_amount ?? 0, 'ZAR', locale) })}
                        </p>
                        <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                          {t('securityDepositDesc')}
                        </p>
                      </div>
                    </div>
                  )}
                  {riskRequirements.ownershipVerificationRequired && (
                    <div className="flex items-start gap-3">
                      <UserCheck size={16} className="text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                          {t('ownershipVerificationRequired')}
                        </p>
                        <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                          {t('ownershipVerificationDesc')}
                        </p>
                      </div>
                    </div>
                  )}
                  {riskRequirements.insuranceRequired && (
                    <div className="flex items-start gap-3">
                      <ShieldCheck size={16} className="text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                          {t('insuranceRequired')}
                        </p>
                        <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                          {t('insuranceRequiredDesc')}
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
                <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">{t('listedBy')}</h2>
                <div className="flex items-center gap-4 p-4 rounded-2xl bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A]">
                  <div className="w-12 h-12 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center text-lg font-bold text-[#6B5B55] dark:text-[#9B8B85] shrink-0">
                    {listing.merchant.display_name?.[0]?.toUpperCase() ?? 'M'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <ProfileLink
                        userId={listing.merchant.id}
                        displayName={resolveMerchantPublicIdentity(listing.merchant).publicName}
                        currentUserId={viewer?.userId ?? null}
                        className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]"
                      />
                      {resolveMerchantPublicIdentity(listing.merchant).isElite && <EliteBadge label={t('eliteBadgeLabel')} />}
                      {listing.merchant.is_verified && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-2 py-0.5 rounded-full">
                          <ShieldCheck size={9} /> {t('kycVerified')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
                      <span className="flex items-center gap-1">
                        <Star size={11} className="text-amber-400 fill-amber-400" />
                        {listing.merchant.unity_score?.toFixed(1)} {t('unityScoreLabel')}
                      </span>
                      <span>
                        {t('memberSince', { date: formatDate(listing.merchant.created_at, locale) })}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Rental details — only for a listing that has a daily rate (rental or both) */}
            {listing.daily_rate !== null && listing.daily_rate !== undefined && (
              <div>
                <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">{t('rentalDetails')}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { label: t('dailyRate'), value: formatMoneyFromRands(listing.daily_rate, 'ZAR', locale) },
                    ...(listing.weekly_rate ? [{ label: t('weeklyRate'), value: formatMoneyFromRands(listing.weekly_rate, 'ZAR', locale) }] : []),
                    { label: t('minimumRental'), value: t('days', { count: listing.min_rental_days }) },
                    ...(listing.insurance_amount ? [{ label: t('insurance'), value: t('perDayAmount', { amount: formatMoneyFromRands(listing.insurance_amount, 'ZAR', locale) }) }] : []),
                    { label: t('shipping'), value: SHIPPING_LABEL[listing.shipping_payer] },
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
            )}

            {/* Sale details — only for a listing that has a sale price (sale or both) */}
            {listing.sale_price !== null && listing.sale_price !== undefined && (
              <div>
                <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">{t('saleDetails')}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { label: t('price'), value: formatMoneyFromRands(listing.sale_price, 'ZAR', locale) },
                    ...(typeof listing.quantity_available === 'number' ? [{ label: t('quantityAvailable'), value: String(listing.quantity_available) }] : []),
                    { label: t('shipping'), value: SHIPPING_LABEL[listing.shipping_payer] },
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
            )}

            {/* Rent-to-Buy summary — only for a listing with enabled, public RTB terms. Full material terms + acceptance happen in the request dialog (RequestRentToBuyButton); this is the truthful, at-a-glance summary Rule 9's "no overloaded card" instruction asks for. */}
            {rtbTerms && (
              <div>
                <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4 flex items-center gap-2">
                  <Wallet size={14} /> {tRtb('rtbSectionTitle')}
                </h2>
                <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-4">{tRtb('rtbSectionDesc')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { label: tRtb('totalPurchasePriceLabel'), value: formatMoneyFromRands(rtbTerms.total_purchase_price, rtbTerms.currency, locale) },
                    { label: tRtb('installmentSummaryLabel'), value: `${formatMoneyFromRands(rtbTerms.installment_amount, rtbTerms.currency, locale)} × ${rtbTerms.installment_count} (${tRtb(`frequency.${rtbTerms.payment_frequency}`)})` },
                    ...(rtbTerms.security_deposit_amount ? [{ label: tRtb('securityDepositLabel'), value: formatMoneyFromRands(rtbTerms.security_deposit_amount, rtbTerms.currency, locale) }] : []),
                    { label: tRtb('rentalUseRateLabel'), value: `${formatMoneyFromRands(rtbTerms.rental_use_rate_amount, rtbTerms.currency, locale)} / ${tRtb(`unit.${rtbTerms.rental_use_rate_unit}`)}` },
                    { label: tRtb('earlyPayoffLabel'), value: rtbTerms.early_payoff_allowed ? tRtb('yes') : tRtb('no') },
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
            )}

            {/* Trust features */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { icon: <ShieldCheck size={18} className="text-green-500" />, title: t('secureCheckout'), desc: t('secureCheckoutDesc') },
                { icon: <CheckCircle size={18} className="text-blue-500" />, title: t('reviewedListing'), desc: t('reviewedListingDesc') },
                { icon: <Star size={18} className="text-amber-400 fill-amber-400" />, title: t('reviewedMerchant'), desc: t('reviewedMerchantDesc') },
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
                  <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85]">{t('reviews')}</h2>
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
                          <ProfileLink
                            userId={review.reviewer?.id}
                            displayName={review.reviewer?.display_name ?? review.reviewer?.full_name ?? 'Anonymous'}
                            currentUserId={viewer?.userId ?? null}
                            className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]"
                          />
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
                          {formatDate(review.created_at, locale)}
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

          {/* ── RIGHT COLUMN — sticky booking/sale card(s) ── */}
          <div className="hidden lg:block">
            <div className="sticky top-24 space-y-5">
              {isCommitted ? (
                <div className="rounded-2xl border border-[#8B1A1A]/30 bg-[#8B1A1A]/5 p-5 text-center">
                  {isBarterLocked ? <Repeat size={22} className="mx-auto text-[#8B1A1A] mb-2" /> : <Wallet size={22} className="mx-auto text-[#8B1A1A] mb-2" />}
                  <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                    {isBarterLocked ? t('committedToTrade') : tRtb('committedToRentToBuy')}
                  </p>
                  <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-1">
                    {isBarterLocked ? t('committedToTradeDesc') : tRtb('committedToRentToBuyDesc')}
                  </p>
                </div>
              ) : (
                <>
                  {listing.daily_rate !== null && listing.daily_rate !== undefined && (
                    <BookingCard listing={{ ...listing, daily_rate: listing.daily_rate }} />
                  )}
                  {listing.sale_price !== null && listing.sale_price !== undefined && (
                    <SaleSummaryCard listing={{ ...listing, sale_price: listing.sale_price }} />
                  )}
                  {canRequestRtb && (
                    <RequestRentToBuyButton listingId={listing.id} terms={rtbTerms!} locale={locale} />
                  )}
                  {canProposeTrade && (
                    <ProposeTradeButton
                      anchorListing={listing}
                      currentUserId={viewer!.userId}
                      myListings={viewerListings}
                      ownerListings={ownerListings}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── SIMILAR LISTINGS ── */}
        {similar.length > 0 && (
          <div className="mt-20 pt-10 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
            <p className="section-label mb-3">{t('youMightAlsoLike')}</p>
            <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-8">
              {t('similarListings')}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {similar.map((l) => (
                <ListingCard key={l.id} listing={l} verifiedLabel={l.ownership_verified ? tCommon('verified') : undefined} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Mobile sticky CTA ── */}
      <div className="lg:hidden fixed bottom-16 left-0 right-0 z-40 px-4 pb-2 bg-gradient-to-t from-[#FAF8F5] dark:from-[#0F0A0A] pt-4 space-y-2">
        {isCommitted ? (
          <div className="flex items-center justify-center gap-2 w-full py-3.5 bg-white dark:bg-[#1A1010] border border-[#8B1A1A]/30 text-[#8B1A1A] font-semibold rounded-xl text-sm shadow-lg">
            {isBarterLocked ? <Repeat size={15} /> : <Wallet size={15} />} {isBarterLocked ? t('committedToTrade') : tRtb('committedToRentToBuy')}
          </div>
        ) : (
          <>
            {listing.daily_rate !== null && listing.daily_rate !== undefined ? (
              <Link
                href={`/listings/${listing.id}/book`}
                className="flex items-center justify-center gap-2 w-full py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm shadow-lg hover:bg-[#7A1616] transition-colors"
              >
                {t('bookNow', { amount: formatMoneyFromRands(listing.daily_rate, 'ZAR', locale) })} <ArrowRight size={16} />
              </Link>
            ) : listing.sale_price !== null && listing.sale_price !== undefined ? (
              <Link
                href={`/listings/${listing.id}/buy`}
                className="flex items-center justify-center gap-2 w-full py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm shadow-lg hover:bg-[#7A1616] transition-colors"
              >
                {t('buyNow', { amount: formatMoneyFromRands(listing.sale_price, 'ZAR', locale) })} <ArrowRight size={16} />
              </Link>
            ) : null}
            {canRequestRtb && (
              <RequestRentToBuyButton
                listingId={listing.id}
                terms={rtbTerms!}
                locale={locale}
                className="flex items-center justify-center gap-2 w-full py-3.5 bg-white dark:bg-[#1A1010] border border-[#8B1A1A] text-[#8B1A1A] font-semibold rounded-xl text-sm shadow-lg hover:bg-[#8B1A1A]/5 transition-colors"
              />
            )}
            {canProposeTrade && (
              <ProposeTradeButton
                anchorListing={listing}
                currentUserId={viewer!.userId}
                myListings={viewerListings}
                ownerListings={ownerListings}
                className="flex items-center justify-center gap-2 w-full py-3.5 bg-white dark:bg-[#1A1010] border border-[#8B1A1A] text-[#8B1A1A] font-semibold rounded-xl text-sm shadow-lg hover:bg-[#8B1A1A]/5 transition-colors"
              />
            )}
          </>
        )}
      </div>
    </div>
    </NextIntlClientProvider>
  )
}
