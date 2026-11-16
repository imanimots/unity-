import type { Metadata } from 'next'
import Image from 'next/image'
import { NextIntlClientProvider } from 'next-intl'
import { getTranslations, getLocale, getMessages } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowRight, ShieldCheck, Star, CheckCircle, ShoppingBag, ArrowLeftRight } from 'lucide-react'
import { getListings } from '@/lib/data/listings'
import { resolveEffectiveCountry } from '@/lib/resolve-effective-country'
import { ListingCard } from '@/components/listings/listing-card'
import { HeroImageCarousel } from '@/components/listings/hero-image-carousel'
import { absoluteUrl, isIndexingEnabled } from '@/lib/seo/config'
import type { Locale } from '@/i18n/locales'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { isPersonalizationEnabled } from '@/lib/personalization/config'
import { RecommendationModule } from '@/components/personalization/recommendation-module'

export async function generateMetadata(): Promise<Metadata> {
  const locale = (await getLocale()) as Locale
  const t = await getTranslations('common.home')
  const title = t('metaTitle')
  const description = t('metaDescription')
  return {
    title,
    description,
    // Omitted while indexing is disabled — see src/lib/seo/config.ts.
    alternates: isIndexingEnabled() ? { canonical: absoluteUrl('/') } : undefined,
    openGraph: { title, description, url: absoluteUrl('/'), type: 'website', locale },
    twitter: { card: 'summary_large_image', title, description },
  }
}

export default async function HomePage() {
  const { countryId } = await resolveEffectiveCountry()
  const featured = await getListings({ sort: 'rating', countryId })
  const topListings = featured.slice(0, 4)
  const tCommon = await getTranslations('common')
  const t = await getTranslations('common.home')
  const verifiedLabel = tCommon('verified')
  const personalizationEnabled = isPersonalizationEnabled()
  // Resolved unconditionally (not just when personalization is on) --
  // the "List an item" CTA needs to know whether to send an anonymous
  // visitor through sign-up or straight into the real listing-creation
  // flow a signed-in member already has.
  const viewer = await getRequestProfile()

  // Narrow scoped provider (same public-dictionary-leak-prevention
  // principle used throughout this codebase) -- only what
  // <RecommendationModule> actually needs client-side, never the full
  // dictionary tree.
  const messages = personalizationEnabled ? await getMessages() : null
  const personalizationScoped = messages
    ? {
        personalization: { modules: messages.personalization.modules, reasons: messages.personalization.reasons },
        common: { categories: messages.common.categories },
        marketplace: { mode: messages.marketplace.mode },
      }
    : null

  const listItemHref = viewer ? '/dashboard/merchant/listings/new' : '/register?role=merchant'

  // Real listing photography for the hero carousel (E47 Phase AO) --
  // never stock/illustrative imagery. Falls back to nothing (the
  // carousel renders null) if no listing has a photo yet.
  const heroImages = topListings
    .map((l) => ({ url: l.media?.[0]?.url, alt: l.title }))
    .filter((img): img is { url: string; alt: string } => Boolean(img.url))
    .slice(0, 3)

  const steps = [
    { num: '01', title: t('howItWorks.browseBookTitle'), desc: t('howItWorks.browseBookDesc') },
    { num: '02', title: t('howItWorks.meetRentTitle'), desc: t('howItWorks.meetRentDesc') },
    { num: '03', title: t('howItWorks.returnReviewTitle'), desc: t('howItWorks.returnReviewDesc') },
  ]

  // Rental and Ambassador are real, working experiences — screenshotted
  // directly from the live pages. Buying & Selling and Bartering are
  // both real and live too (confirmed: /listings?mode=buy and
  // /listings?mode=barter are unconditionally reachable, no feature
  // flag gates either) -- this section previously mislabelled Barter
  // "Coming soon", which was stale copy from before Barter shipped;
  // corrected here rather than carried forward into the redesign.
  const platformFeatures = [
    {
      key: 'rental',
      label: t('platformFeatures.rentalLabel'),
      heading: t('platformFeatures.rentalHeading'),
      desc: t('platformFeatures.rentalDesc'),
      image: '/home-features/rental-marketplace.png',
      imageAlt: t('platformFeatures.rentalImageAlt'),
      icon: null,
      cta: { label: t('platformFeatures.rentalCta'), href: '/listings' },
    },
    {
      key: 'buy-sell',
      label: t('platformFeatures.buySellLabel'),
      heading: t('platformFeatures.buySellHeading'),
      desc: t('platformFeatures.buySellDesc'),
      image: null,
      imageAlt: null,
      icon: <ShoppingBag size={32} strokeWidth={1.5} />,
      cta: { label: t('platformFeatures.buySellCta'), href: '/listings?mode=buy' },
    },
    {
      key: 'barter',
      label: t('platformFeatures.barterLabel'),
      heading: t('platformFeatures.barterHeading'),
      desc: t('platformFeatures.barterDesc'),
      image: null,
      imageAlt: null,
      icon: <ArrowLeftRight size={32} strokeWidth={1.5} />,
      cta: { label: t('platformFeatures.barterCta'), href: '/listings?mode=barter' },
    },
    {
      key: 'ambassador',
      label: t('platformFeatures.ambassadorLabel'),
      heading: t('platformFeatures.ambassadorHeading'),
      desc: t('platformFeatures.ambassadorDesc'),
      image: '/home-features/ambassador-program.png',
      imageAlt: t('platformFeatures.ambassadorImageAlt'),
      icon: null,
      cta: { label: t('platformFeatures.ambassadorCta'), href: '/ambassadors' },
    },
  ]

  const trust = [
    { icon: <ShieldCheck size={22} strokeWidth={1.5} />, title: t('trust.testModeTitle'), desc: t('trust.testModeDesc') },
    { icon: <CheckCircle size={22} strokeWidth={1.5} />, title: t('trust.identityReviewedTitle'), desc: t('trust.identityReviewedDesc') },
    { icon: <Star size={22} strokeWidth={1.5} />, title: t('trust.ratedCommunityTitle'), desc: t('trust.ratedCommunityDesc') },
  ]

  return (
    <div className="min-h-screen">

      {/* ─── 1. HERO ──────────────────────────────────────────────── */}
      <section className="bg-[#FAF8F5] overflow-hidden">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16 py-20 lg:py-28">
          <div className="flex flex-col lg:flex-row lg:items-center lg:gap-16">

            {/* Left column */}
            <div className="flex-1 min-w-0">
              <p className="section-label mb-6">{t('hero.eyebrow')}</p>

              <h1 className="mb-6">
                <span className="display-heading block text-[#1A0A0A]">{t('hero.headlineLine1')}</span>
                <span className="display-heading block text-[#8B1A1A]">{t('hero.headlineLine2')}</span>
              </h1>

              <p className="text-base text-[#6B5B55] mb-10 max-w-sm leading-relaxed">
                {t('hero.description')}
              </p>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/listings"
                  className="inline-flex items-center gap-2 px-7 py-3.5 bg-[#8B1A1A] text-white text-sm font-semibold rounded-full hover:bg-[#7A1616] transition-colors"
                >
                  {t('hero.exploreCta')} <ArrowRight size={15} />
                </Link>
                <Link
                  href={listItemHref}
                  className="inline-flex items-center gap-2 px-7 py-3.5 border border-[#1A0A0A] text-[#1A0A0A] text-sm font-semibold rounded-full hover:bg-[#F2EDE8] transition-colors"
                >
                  {t('hero.listItemCta')}
                </Link>
              </div>
            </div>

            {/* Right column — real listing photography carousel */}
            {heroImages.length > 0 && (
              <div className="hidden lg:block relative flex-shrink-0 w-[480px] h-[420px]">
                <HeroImageCarousel images={heroImages} />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ─── 2. THREE STEPS ──────────────────────────────────────── */}
      <section id="how-it-works" className="bg-[#1A0A0A] py-20 lg:py-24 scroll-mt-16">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">
          <p className="section-label mb-4 text-[#9B8B85]">{t('howItWorks.eyebrow')}</p>
          <h2 className="section-heading text-white mb-14 max-lg:mb-10">{t('howItWorks.heading')}</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
            {steps.map(({ num, title, desc }) => (
              <div key={num}>
                <div className="w-12 h-12 rounded-full bg-[#2A1A1A] text-[#9B8B85] flex items-center justify-center font-bold text-sm mb-5">
                  {num}
                </div>
                <h3 className="text-lg font-extrabold uppercase text-white mb-2">{title}</h3>
                <p className="text-sm text-[#9B8B85] leading-relaxed max-w-xs">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── 3. POPULAR NEAR YOU ─────────────────────────────────── */}
      <section className="bg-[#FAF8F5] py-20 lg:py-24">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">
          <div className="flex items-start justify-between gap-4 mb-4">
            <p className="section-label">{t('browseSection.eyebrow')}</p>
            <Link
              href="/listings"
              className="inline-flex items-center gap-2 text-sm font-semibold text-[#1A0A0A] border-b border-[#1A0A0A] pb-0.5 hover:text-[#8B1A1A] hover:border-[#8B1A1A] transition-colors"
            >
              {t('browseSection.browseAllListings')} <ArrowRight size={14} />
            </Link>
          </div>
          <h2 className="section-heading text-[#1A0A0A] mb-10">{t('browseSection.heading')}</h2>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
            {topListings.map((listing, i) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                priority={i < 2}
                verifiedLabel={listing.ownership_verified ? verifiedLabel : undefined}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ─── PERSONALIZATION MODULES (Section 30/31) ────────────────
          Client-only islands -- render nothing when there's no
          meaningful signal (cold start / feature disabled / no
          history), never a fabricated "Recommended for you". */}
      {personalizationEnabled && personalizationScoped && (
        <NextIntlClientProvider messages={personalizationScoped}>
          <RecommendationModule module="continue_browsing" isSignedIn={Boolean(viewer)} />
          <RecommendationModule module="recommended_for_you" isSignedIn={Boolean(viewer)} />
        </NextIntlClientProvider>
      )}

      {/* ─── 4. FOUR WAYS TO USE UNITY ───────────────────────────── */}
      <section className="bg-white py-20 lg:py-24">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">
          <p className="section-label mb-4">{t('platformFeatures.eyebrow')}</p>
          <h2 className="section-heading text-[#1A0A0A] mb-14 max-lg:mb-10">{t('platformFeatures.heading')}</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {platformFeatures.map((feature) => (
              <div key={feature.key} className="flex gap-5 p-5 rounded-2xl border border-[#F2EDE8] bg-[#FAF8F5]">
                <div className="relative w-24 h-24 shrink-0 rounded-xl overflow-hidden bg-[#F2EDE8] flex items-center justify-center">
                  {feature.image ? (
                    <Image src={feature.image} alt={feature.imageAlt ?? ''} fill className="object-cover" sizes="96px" />
                  ) : (
                    <div className="text-[#9B8B85]">{feature.icon}</div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-extrabold text-[#1A0A0A] leading-tight mb-1.5">{feature.heading}</h3>
                  <p className="text-sm text-[#6B5B55] leading-relaxed mb-3">{feature.desc}</p>
                  <Link
                    href={feature.cta.href}
                    className="inline-flex items-center justify-center px-4 py-2 rounded-full bg-[#8B1A1A] text-white text-xs font-semibold hover:bg-[#7A1616] transition-colors"
                  >
                    {feature.cta.label}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── 5. TRUST SECTION ────────────────────────────────────── */}
      <section className="bg-[#1A0A0A] py-20 lg:py-24 text-white">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">
          <p className="section-label mb-4" style={{ color: '#6B5B55' }}>{t('trust.eyebrow')}</p>
          <h2 className="section-heading text-white mb-14 max-lg:mb-10">
            {t('trust.headingLine1')} {t('trust.headingLine2')} {t('trust.headingLine3')}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#2A1A1A]">
            {trust.map(({ icon, title, desc }) => (
              <div key={title} className="px-8 py-10 max-md:px-0 first:pl-0 last:pr-0 max-md:first:pt-0">
                <div className="text-[#9B8B85] mb-5">{icon}</div>
                <h3 className="text-base font-extrabold uppercase tracking-wide mb-2">{title}</h3>
                <p className="text-sm text-[#9B8B85] leading-relaxed max-w-xs">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── 6. START EARNING TODAY ──────────────────────────────── */}
      <section className="bg-[#8B1A1A] py-20 lg:py-24">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">
          <h2 className="section-heading text-white mb-4">{t('finalCta.heading')}</h2>
          <p className="text-white/70 text-base mb-10">
            {t('finalCta.description')}
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href={listItemHref}
              className="inline-flex items-center gap-2 px-7 py-3.5 bg-white text-[#1A0A0A] text-sm font-semibold rounded-full hover:bg-[#F5F0ED] transition-colors"
            >
              {t('finalCta.listItem')} <ArrowRight size={15} />
            </Link>
            <Link
              href="/listings"
              className="inline-flex items-center gap-2 px-7 py-3.5 border border-white/40 text-white text-sm font-semibold rounded-full hover:border-white/80 transition-colors"
            >
              {t('finalCta.exploreItems')}
            </Link>
          </div>
        </div>
      </section>

    </div>
  )
}
