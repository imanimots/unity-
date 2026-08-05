import Link from 'next/link'
import Image from 'next/image'
import { ArrowRight, ShieldCheck, Star, CheckCircle, ShoppingBag, ArrowLeftRight } from 'lucide-react'
import { getListings } from '@/lib/data/listings'
import { resolveEffectiveCountry } from '@/lib/resolve-effective-country'
import { ListingCard } from '@/components/listings/listing-card'

export const metadata = {
  title: 'Unity — Rent What You Need. Earn From What You Have.',
  description: "South Africa's peer-to-peer rental marketplace. Identity-reviewed users and test-mode checkout.",
}

const MARQUEE_TEXT =
  'CAMERAS • CAMPING • POWER TOOLS • DRONES • BICYCLES • AUDIO GEAR • LIGHTING • PROJECTORS • SPORTS • GARDEN • EVENTS • VEHICLES • '

const STEPS = [
  {
    num: '01',
    title: 'BROWSE & BOOK',
    desc: 'Find what you need, pick your dates, and pay securely through Unity\'s checkout.',
  },
  {
    num: '02',
    title: 'MEET & RENT',
    desc: 'Collect or receive the item from a reviewed local owner and start using it.',
  },
  {
    num: '03',
    title: 'RETURN & REVIEW',
    desc: 'Hand it back in good shape, get your deposit released, and leave an honest review.',
  },
]

// Rental and Ambassador are real, working experiences — screenshotted
// directly from the live pages. Buying & Selling browsing and listing
// creation are real too, but use an illustrative icon panel rather than a
// screenshot since no dedicated marketing screenshot exists yet — see
// docs/BUYING_SELLING.md. Purchasing itself (checkout/orders) isn't live,
// so its CTA goes straight to the real Buy-filtered browse view rather
// than claiming a purchase flow exists. Bartering has no backing feature
// at all yet, so it stays "Coming soon".
const PLATFORM_FEATURES = [
  {
    key: 'rental',
    label: 'RENTAL MARKETPLACE',
    heading: 'BROWSE AND BOOK ITEMS NEAR YOU.',
    desc: 'Rent cameras, tools, camping gear and more from reviewed local owners — pick your dates and check out securely.',
    image: '/home-features/rental-marketplace.png',
    imageAlt: 'Screenshot of the Unity rental listings browse page',
    icon: null,
    cta: { label: 'Browse Rentals', href: '/listings' },
    comingSoon: false,
  },
  {
    key: 'buy-sell',
    label: 'BUYING & SELLING MARKETPLACE',
    heading: 'BUY AND SELL ITEMS OUTRIGHT.',
    desc: 'Buy and sell items outright, alongside renting — using the same trusted, identity-reviewed community and secure test-mode checkout.',
    image: null,
    imageAlt: null,
    icon: <ShoppingBag size={40} strokeWidth={1.5} />,
    cta: { label: 'Browse For Sale', href: '/listings?mode=buy' },
    comingSoon: false,
  },
  {
    key: 'barter',
    label: 'BARTERING',
    heading: 'TRADE ITEMS DIRECTLY.',
    desc: 'Swap what you have for what you need — no cash required. More details on how bartering will work are coming soon.',
    image: null,
    imageAlt: null,
    icon: <ArrowLeftRight size={40} strokeWidth={1.5} />,
    cta: null,
    comingSoon: true,
  },
  {
    key: 'ambassador',
    label: 'AMBASSADOR / AFFILIATE PROGRAM',
    heading: 'EARN BY REFERRING NEW MEMBERS.',
    desc: 'Share your referral link and earn commission every time someone you refer completes a rental.',
    image: '/home-features/ambassador-program.png',
    imageAlt: 'Screenshot of the Unity Ambassador Program page',
    icon: null,
    cta: { label: 'Learn More', href: '/ambassadors' },
    comingSoon: false,
  },
]

const TRUST = [
  {
    icon: <ShieldCheck size={22} strokeWidth={1.5} />,
    title: 'TEST-MODE CHECKOUT',
    desc: 'Unity is in public test — payments are currently simulated. See the Payment & Deposit Policy.',
  },
  {
    icon: <CheckCircle size={22} strokeWidth={1.5} />,
    title: 'IDENTITY REVIEWED',
    desc: 'Every user\'s identity is reviewed by Unity before transacting.',
  },
  {
    icon: <Star size={22} strokeWidth={1.5} />,
    title: 'RATED COMMUNITY',
    desc: 'Transparent ratings hold renters and owners equally accountable.',
  },
]

export default async function HomePage() {
  const { countryId } = await resolveEffectiveCountry()
  const featured = await getListings({ sort: 'rating', countryId })
  const topListings = featured.slice(0, 6)

  return (
    <div className="min-h-screen">

      {/* ─── 1. HERO ──────────────────────────────────────────────── */}
      <section className="bg-[#FAF8F5] overflow-hidden">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16 py-[120px] max-lg:py-20">
          <div className="flex flex-col lg:flex-row lg:items-start lg:gap-16">

            {/* Left column */}
            <div className="flex-1 min-w-0">
              <p className="section-label mb-8">PEER-TO-PEER RENTALS · SOUTH AFRICA</p>

              <h1 className="mb-6">
                <span className="display-heading block text-[#1A0A0A]">RENT</span>
                <span className="display-heading block text-[#8B1A1A]">ANYTHING.</span>
              </h1>

              <p className="text-base text-[#6B5B55] mb-10 max-w-sm leading-relaxed">
                Unity connects South Africans to rent and lend safely — reviewed users, secure checkout.
              </p>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/register"
                  className="inline-flex items-center gap-2 px-7 py-3.5 bg-[#8B1A1A] text-white text-sm font-semibold rounded-full hover:bg-[#7A1616] transition-colors"
                >
                  Get Started <ArrowRight size={15} />
                </Link>
                <Link
                  href="/listings"
                  className="inline-flex items-center gap-2 px-7 py-3.5 border border-[#1A0A0A] text-[#1A0A0A] text-sm font-semibold rounded-full hover:bg-[#F2EDE8] transition-colors"
                >
                  Browse Items
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
          {[MARQUEE_TEXT, MARQUEE_TEXT].map((text, i) => (
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
              <span className="section-label">[02]</span>
              <span className="section-label">BROWSE</span>
            </div>
          </div>
          <h2 className="section-heading text-[#1A0A0A]">WHAT&apos;S AVAILABLE.</h2>

          {/* Listings grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-12">
            {topListings.map((listing, i) => (
              <ListingCard key={listing.id} listing={listing} priority={i < 2} />
            ))}
          </div>

          <div className="flex justify-end mt-10">
            <Link
              href="/listings"
              className="inline-flex items-center gap-2 text-sm font-semibold text-[#1A0A0A] border-b border-[#1A0A0A] pb-0.5 hover:text-[#8B1A1A] hover:border-[#8B1A1A] transition-colors"
            >
              Browse all listings <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>

      {/* ─── 4. HOW IT WORKS ─────────────────────────────────────── */}
      <section id="how-it-works" className="bg-white py-[120px] max-lg:py-20 scroll-mt-16">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">

          <div className="flex items-center gap-3 mb-4">
            <span className="section-label">[03]</span>
            <span className="section-label">HOW IT WORKS</span>
          </div>
          <h2 className="section-heading text-[#1A0A0A] mb-16 max-lg:mb-12">THREE STEPS.</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#F2EDE8]">
            {STEPS.map(({ num, title, desc }) => (
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
            <span className="section-label">[04]</span>
            <span className="section-label">WHAT UNITY OFFERS</span>
          </div>
          <h2 className="section-heading text-[#1A0A0A] mb-16 max-lg:mb-12">FOUR WAYS TO USE UNITY.</h2>

          <div className="flex flex-col gap-20 max-lg:gap-14">
            {PLATFORM_FEATURES.map((feature, i) => {
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
                        Coming soon
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
            <span className="section-label">[05]</span>
            <span className="section-label" style={{ color: '#6B5B55' }}>TRUST</span>
          </div>
          <h2 className="section-heading text-white mb-16 max-lg:mb-12">
            VERIFIED.<br />PROTECTED.<br className="sm:hidden" /> TRUSTED.
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#2A1A1A]">
            {TRUST.map(({ icon, title, desc }) => (
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
          <h2 className="section-heading text-white mb-4">START EARNING TODAY.</h2>
          <p className="text-white/70 text-base mb-10">
            List your first item in under 5 minutes.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/register?role=merchant"
              className="inline-flex items-center gap-2 px-7 py-3.5 bg-white text-[#1A0A0A] text-sm font-semibold rounded-full hover:bg-[#F5F0ED] transition-colors"
            >
              List an item <ArrowRight size={15} />
            </Link>
            <Link
              href="/#how-it-works"
              className="inline-flex items-center gap-2 px-7 py-3.5 border border-white/40 text-white text-sm font-semibold rounded-full hover:border-white/80 transition-colors"
            >
              How it works
            </Link>
          </div>
        </div>
      </section>

    </div>
  )
}
