import type { Metadata } from 'next'
import Image from 'next/image'
import { NextIntlClientProvider } from 'next-intl'
import { getTranslations, getLocale, getMessages } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowRight, ShieldCheck, Star, CheckCircle, ShoppingBag, ArrowLeftRight } from 'lucide-react'
import { getListings } from '@/lib/data/listings'
import { resolveEffectiveCountry } from '@/lib/resolve-effective-country'
import { ListingCard } from '@/components/listings/listing-card'
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
  const topListings = featured.slice(0, 6)
  const tCommon = await getTranslations('common')
  const t = await getTranslations('common.home')
  const verifiedLabel = tCommon('verified')
  const personalizationEnabled = isPersonalizationEnabled()
  const viewer = personalizationEnabled ? await getRequestProfile() : null

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

  const marqueeText = t('marquee')

  const steps = [
    { num: '01', title: t('howItWorks.browseBookTitle'), desc: t('howItWorks.browseBookDesc') },
    { num: '02', title: t('howItWorks.meetRentTitle'), desc: t('howItWorks.meetRentDesc') },
    { num: '03', title: t('howItWorks.returnReviewTitle'), desc: t('howItWorks.returnReviewDesc') },
  ]

  // Rental and Ambassador are real, working experiences — screenshotted
  // directly from the live pages. Buying & Selling browsing and listing
  // creation are real too, but use an illustrative icon panel rather than a
  // screenshot since no dedicated marketing screenshot exists yet — see
  // docs/BUYING_SELLING.md. Purchasing itself (checkout/orders) isn't live,
  // so its CTA goes straight to the real Buy-filtered browse view rather
  // than claiming a purchase flow exists. Bartering has no backing feature
  // at all yet, so it stays "Coming soon".
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
      comingSoon: false,
    },
    {
      key: 'buy-sell',
      label: t('platformFeatures.buySellLabel'),
      heading: t('platformFeatures.buySellHeading'),
      desc: t('platformFeatures.buySellDesc'),
      image: null,
      imageAlt: null,
      icon: <ShoppingBag size={40} strokeWidth={1.5} />,
      cta: { label: t('platformFeatures.buySellCta'), href: '/listings?mode=buy' },
      comingSoon: false,
    },
    {
      key: 'barter',
      label: t('platformFeatures.barterLabel'),
      heading: t('platformFeatures.barterHeading'),
      desc: t('platformFeatures.barterDesc'),
      image: null,
      imageAlt: null,
      icon: <ArrowLeftRight size={40} strokeWidth={1.5} />,
      cta: null,
      comingSoon: true,
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
      comingSoon: false,
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
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16 py-[120px] max-lg:py-20">
          <div className="flex flex-col lg:flex-row lg:items-start lg:gap-16">

            {/* Left column */}
            <div className="flex-1 min-w-0">
              <p className="section-label mb-8">{t('hero.eyebrow')}</p>

              <h1 className="mb-6">
                <span className="display-heading block text-[#1A0A0A]">{t('hero.headlineLine1')}</span>
                <span className="display-heading block text-[#8B1A1A]">{t('hero.headlineLine2')}</span>
              </h1>

              <p className="text-base text-[#6B5B55] mb-10 max-w-sm leading-relaxed">
                {t('hero.description')}
              </p>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/register"
                  className="inline-flex items-center gap-2 px-7 py-3.5 bg-[#8B1A1A] text-white text-sm font-semibold rounded-full hover:bg-[#7A1616] transition-colors"
                >
                  {t('hero.getStarted')} <ArrowRight size={15} />
                </Link>
                <Link
                  href="/listings"
                  className="inline-flex items-center gap-2 px-7 py-3.5 border border-[#1A0A0A] text-[#1A0A0A] text-sm font-semibold rounded-full hover:bg-[#F2EDE8] transition-colors"
                >
                  {t('hero.browseItems')}
                </Link>
              </div>
            </div>

            {/* Right column — asymmetric image grid */}
            <div className="hidden lg:block relative flex-shrink-0 w-[560px] h-[420px]">
              {/* Large square — bottom-left anchor */}
              <div className="absolute left-0 bottom-0 bg-[#F2EDE8] h-[400px] w-[320px]" />
              {/* Small square — lower-right offset */}
              <div className="absolute left-[340px] bottom-0 bg-[#E8E0D8] h-[200px] w-[200px]" />
              {/* Tall rectangle — top-right overlapping */}
              <div className="absolute left-[300px] top-0 bg-[#EDE8E0] h-[300px] w-[240px]" />
            </div>
          </div>
        </div>
      </section>

      {/* ─── 2. MARQUEE TICKER ───────────────────────────────────── */}
      <section className="bg-[#1A0A0A] py-5 overflow-hidden">
        <div
          className="animate-marquee flex whitespace-nowrap"
          style={{ width: 'max-content' }}
        >
          {[marqueeText, marqueeText].map((text, i) => (
            <span
              key={i}
              className="text-white text-sm font-medium uppercase tracking-[0.1em] pr-0"
            >
              {text}
            </span>
          ))}
        </div>
      </section>

      {/* ─── 3. FEATURED LISTINGS ────────────────────────────────── */}
      <section className="bg-[#FAF8F5] py-[120px] max-lg:py-20">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">

          {/* Section header */}
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              <span className="section-label">{t('browseSection.stepLabel')}</span>
              <span className="section-label">{t('browseSection.sectionLabel')}</span>
            </div>
          </div>
          <h2 className="section-heading text-[#1A0A0A]">{t('browseSection.heading')}</h2>

          {/* Listings grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-12">
            {topListings.map((listing, i) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                priority={i < 2}
                verifiedLabel={listing.ownership_verified ? verifiedLabel : undefined}
              />
            ))}
          </div>

          <div className="flex justify-end mt-10">
            <Link
              href="/listings"
              className="inline-flex items-center gap-2 text-sm font-semibold text-[#1A0A0A] border-b border-[#1A0A0A] pb-0.5 hover:text-[#8B1A1A] hover:border-[#8B1A1A] transition-colors"
            >
              {t('browseSection.browseAllListings')} <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      {/* ─── PERSONALIZATION MODULES (Section 30/31) ────────────────
          Client-only islands -- render nothing when there's no
          meaningful signal (cold start / feature disabled / no
          history), never a fabricated "Recommended for you". Continue
          Browsing first per the documented module-ordering rule. */}
      {personalizationEnabled && personalizationScoped && (
        <NextIntlClientProvider messages={personalizationScoped}>
          <RecommendationModule module="continue_browsing" isSignedIn={Boolean(viewer)} />
          <RecommendationModule module="recommended_for_you" isSignedIn={Boolean(viewer)} />
        </NextIntlClientProvider>
      )}

      {/* ─── 4. HOW IT WORKS ─────────────────────────────────────── */}
      <section id="how-it-works" className="bg-white py-[120px] max-lg:py-20 scroll-mt-16">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">

          <div className="flex items-center gap-3 mb-4">
            <span className="section-label">{t('howItWorks.stepLabel')}</span>
            <span className="section-label">{t('howItWorks.sectionLabel')}</span>
          </div>
          <h2 className="section-heading text-[#1A0A0A] mb-16 max-lg:mb-12">{t('howItWorks.heading')}</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#F2EDE8]">
            {steps.map(({ num, title, desc }) => (
              <div key={num} className="relative px-8 py-10 max-md:px-0 first:pl-0 last:pr-0 max-md:first:pt-0">
                {/* Ghost number */}
                <div className="text-[80px] font-extrabold text-[#F2EDE8] leading-none select-none mb-4">
                  {num}
                </div>
                <h3 className="text-xl font-extrabold uppercase text-[#1A0A0A] mb-2">{title}</h3>
                <p className="text-sm text-[#6B5B55] leading-relaxed max-w-xs">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── 5. PLATFORM FEATURES ────────────────────────────────── */}
      <section className="bg-[#FAF8F5] py-[120px] max-lg:py-20">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">

          <div className="flex items-center gap-3 mb-4">
            <span className="section-label">{t('platformFeatures.stepLabel')}</span>
            <span className="section-label">{t('platformFeatures.sectionLabel')}</span>
          </div>
          <h2 className="section-heading text-[#1A0A0A] mb-16 max-lg:mb-12">{t('platformFeatures.heading')}</h2>

          <div className="flex flex-col gap-20 max-lg:gap-14">
            {platformFeatures.map((feature, i) => {
              const imageFirst = i % 2 === 0
              const media = (
                <div className={`flex-1 min-w-0 ${imageFirst ? 'lg:order-1' : 'lg:order-2'}`}>
                  {feature.image ? (
                    <div className="relative aspect-[4/3] rounded-2xl overflow-hidden bg-[#F2EDE8] border border-[#F2EDE8]">
                      <Image
                        src={feature.image}
                        alt={feature.imageAlt ?? ''}
                        fill
                        className="object-cover object-top"
                        sizes="(max-width: 1024px) 100vw, 50vw"
                      />
                    </div>
                  ) : (
                    <div className="relative aspect-[4/3] rounded-2xl overflow-hidden bg-[#F2EDE8] border border-[#F2EDE8] flex items-center justify-center">
                      <div className="text-[#9B8B85]">{feature.icon}</div>
                    </div>
                  )}
                </div>
              )
              const text = (
                <div className={`flex-1 min-w-0 flex flex-col justify-center ${imageFirst ? 'lg:order-2' : 'lg:order-1'}`}>
                  <div className="flex items-center gap-3 mb-4">
                    <span className="section-label">{feature.label}</span>
                    {feature.comingSoon && (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-[#E8E0D8] text-[#6B5B55] text-[10px] font-bold uppercase tracking-[0.1em]">
                        {t('platformFeatures.comingSoon')}
                      </span>
                    )}
                  </div>
                  <h3 className="text-2xl lg:text-3xl font-extrabold uppercase text-[#1A0A0A] mb-4 leading-tight">
                    {feature.heading}
                  </h3>
                  <p className="text-base text-[#6B5B55] leading-relaxed mb-6 max-w-md">
                    {feature.desc}
                  </p>
                  {feature.cta && (
                    <Link
                      href={feature.cta.href}
                      className="inline-flex items-center gap-2 w-fit text-sm font-semibold text-[#1A0A0A] border-b border-[#1A0A0A] pb-0.5 hover:text-[#8B1A1A] hover:border-[#8B1A1A] transition-colors"
                    >
                      {feature.cta.label} <ArrowRight size={14} />
                    </Link>
                  )}
                </div>
              )
              return (
                <div key={feature.key} className="flex flex-col lg:flex-row lg:items-center gap-10 lg:gap-16">
                  {media}
                  {text}
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* ─── 6. TRUST SECTION ────────────────────────────────────── */}
      <section className="bg-[#1A0A0A] py-[120px] max-lg:py-20 text-white">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">

          <div className="flex items-center gap-3 mb-4">
            <span className="section-label">{t('trust.stepLabel')}</span>
            <span className="section-label" style={{ color: '#6B5B55' }}>{t('trust.sectionLabel')}</span>
          </div>
          <h2 className="section-heading text-white mb-16 max-lg:mb-12">
            {t('trust.headingLine1')}<br />{t('trust.headingLine2')}<br className="sm:hidden" /> {t('trust.headingLine3')}
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

      {/* ─── 6. FINAL CTA ────────────────────────────────────────── */}
      <section className="bg-[#8B1A1A] py-[120px] max-lg:py-20">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">
          <h2 className="section-heading text-white mb-4">{t('finalCta.heading')}</h2>
          <p className="text-white/70 text-base mb-10">
            {t('finalCta.description')}
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/register?role=merchant"
              className="inline-flex items-center gap-2 px-7 py-3.5 bg-white text-[#1A0A0A] text-sm font-semibold rounded-full hover:bg-[#F5F0ED] transition-colors"
            >
              {t('finalCta.listItem')} <ArrowRight size={15} />
            </Link>
            <Link
              href="/#how-it-works"
              className="inline-flex items-center gap-2 px-7 py-3.5 border border-white/40 text-white text-sm font-semibold rounded-full hover:border-white/80 transition-colors"
            >
              {t('finalCta.howItWorks')}
            </Link>
          </div>
        </div>
      </section>

    </div>
  )
}
