import Link from 'next/link'
import { ArrowRight, ShieldCheck, Star, CheckCircle } from 'lucide-react'
import { getListings } from '@/lib/data/listings'
import { ListingCard } from '@/components/listings/listing-card'

export const metadata = {
  title: 'Unity — Rent What You Need. Earn From What You Have.',
  description: "South Africa's peer-to-peer rental marketplace. Verified users, escrow-protected payments, and thousands of items near you.",
}

const MARQUEE_TEXT =
  'CAMERAS • CAMPING • POWER TOOLS • DRONES • BICYCLES • AUDIO GEAR • LIGHTING • PROJECTORS • SPORTS • GARDEN • EVENTS • VEHICLES • '

const STATS = [
  { value: '1,200+', label: 'Items listed' },
  { value: '4.9★', label: 'Avg rating' },
  { value: 'ZAR R0', label: 'Fees — first rental' },
  { value: '24h', label: 'Support' },
]

const STEPS = [
  {
    num: '01',
    title: 'BROWSE & BOOK',
    desc: 'Find what you need, pick your dates, and pay securely — your money is held in escrow.',
  },
  {
    num: '02',
    title: 'MEET & RENT',
    desc: 'Collect or receive the item from a verified local owner and start using it.',
  },
  {
    num: '03',
    title: 'RETURN & REVIEW',
    desc: 'Hand it back in good shape, get your deposit released, and leave an honest review.',
  },
]

const TRUST = [
  {
    icon: <ShieldCheck size={22} strokeWidth={1.5} />,
    title: 'ESCROW PAYMENTS',
    desc: 'Funds held securely until both sides confirm the return.',
  },
  {
    icon: <CheckCircle size={22} strokeWidth={1.5} />,
    title: 'KYC VERIFIED',
    desc: 'Every user has verified their identity before transacting.',
  },
  {
    icon: <Star size={22} strokeWidth={1.5} />,
    title: 'RATED COMMUNITY',
    desc: 'Transparent ratings hold renters and owners equally accountable.',
  },
]

export default async function HomePage() {
  const featured = await getListings({ sort: 'rating' })
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
                Unity connects South Africans to rent and lend safely — verified users, protected payments.
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

          {/* Stat strip */}
          <div className="mt-20 max-lg:mt-14 border-t border-[#F2EDE8] pt-10 grid grid-cols-2 sm:grid-cols-4 gap-8">
            {STATS.map(({ value, label }) => (
              <div key={label}>
                <div className="text-2xl font-extrabold text-[#1A0A0A] leading-none mb-1">{value}</div>
                <div className="section-label">{label}</div>
              </div>
            ))}
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
      <section className="bg-white py-[120px] max-lg:py-20">
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

      {/* ─── 5. TRUST SECTION ────────────────────────────────────── */}
      <section className="bg-[#1A0A0A] py-[120px] max-lg:py-20 text-white">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-16">

          <div className="flex items-center gap-3 mb-4">
            <span className="section-label">[04]</span>
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
              href="/how-it-works"
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
