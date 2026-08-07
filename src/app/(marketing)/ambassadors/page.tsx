import type { Metadata } from 'next'
import Link from 'next/link'
import { CheckCircle, Users, TrendingUp, Globe, ArrowRight, Star, Zap } from 'lucide-react'
import { absoluteUrl, isIndexingEnabled } from '@/lib/seo/config'

const TITLE = 'Ambassador Program — Unity'
const DESCRIPTION = 'Earn commission referring new renters and merchants to Unity.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: isIndexingEnabled() ? { canonical: absoluteUrl('/ambassadors') } : undefined,
  openGraph: { title: TITLE, description: DESCRIPTION, url: absoluteUrl('/ambassadors'), type: 'website' },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
}

const TIERS = [
  {
    name: 'Starter',
    referrals: '1–4',
    commission: '5%',
    perks: ['Personal referral link', 'Monthly commission payouts', 'Ambassador badge on profile'],
  },
  {
    name: 'Growth',
    referrals: '5–19',
    commission: '8%',
    perks: ['Everything in Starter', 'Priority support', 'Early access to new features', 'Quarterly bonus pool'],
    highlight: true,
  },
  {
    name: 'Elite',
    referrals: '20+',
    commission: '12%',
    perks: ['Everything in Growth', 'Dedicated account manager', 'Co-marketing opportunities', 'Annual retreat invite'],
  },
]

const HOW_IT_WORKS = [
  { step: '01', title: 'Apply via Warp', desc: 'Sign up through our affiliate partner Warp. No upfront cost, no commitment.' },
  { step: '02', title: 'Get your link', desc: 'Receive a unique referral link you can share anywhere — social, WhatsApp, email.' },
  { step: '03', title: 'Refer merchants', desc: 'Merchants who sign up through your link and list items are tracked automatically.' },
  { step: '04', title: 'Earn commission', desc: 'Get a percentage of every completed rental made via listings you referred.' },
]

const WARP_URL = process.env.NEXT_PUBLIC_WARP_AFFILIATE_URL ?? '#'

export default function AmbassadorsPage() {
  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">

      {/* Hero */}
      <section className="bg-[#1A0A0A] text-white py-[120px] px-4">
        <div className="max-w-5xl mx-auto">
          <p className="section-label text-[#C4511F] mb-6">EARN WITH UNITY</p>
          <h1 className="section-heading text-white mb-8 max-w-3xl">
            BECOME AN<br />AMBASSADOR.
          </h1>
          <p className="text-[#9B8B85] text-lg max-w-xl mb-10 leading-relaxed">
            Refer merchants to the Unity platform and earn commission on every rental they complete — for as long as they list with us.
          </p>
          <div className="flex flex-col sm:flex-row items-start gap-4">
            <a
              href={WARP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-7 py-3.5 bg-[#8B1A1A] hover:bg-[#7A1616] text-white font-semibold uppercase tracking-[0.05em] text-sm rounded-xl transition-colors"
            >
              Join via Warp <ArrowRight size={16} />
            </a>
            <p className="text-[#6B5B55] text-sm mt-3 sm:mt-3.5">No cost to join · Payouts monthly via Warp</p>
          </div>
        </div>
      </section>

      {/* Stats bar */}
      <section className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010]">
        <div className="max-w-5xl mx-auto grid grid-cols-3 divide-x divide-[#F2EDE8] dark:divide-[#2A1A1A]">
          {[
            { value: '12%', label: 'Max commission rate' },
            { value: 'Monthly', label: 'Payout schedule' },
            { value: 'Lifetime', label: 'Tracking on referred listings' },
          ].map(({ value, label }) => (
            <div key={label} className="py-8 px-6 text-center">
              <div className="text-3xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] mb-1">{value}</div>
              <div className="text-sm text-[#6B5B55] dark:text-[#9B8B85] uppercase tracking-[0.05em]">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-5xl mx-auto px-4 py-24">
        <p className="section-label text-[#9B8B85] mb-4">THE PROCESS</p>
        <h2 className="text-4xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-14">
          How it works
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {HOW_IT_WORKS.map(({ step, title, desc }) => (
            <div key={step} className="flex gap-5 p-6 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010]">
              <div className="text-[#8B1A1A] font-extrabold text-xs font-mono shrink-0 pt-1 tracking-[0.1em]">{step}</div>
              <div>
                <div className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2 uppercase tracking-[0.03em] text-sm">{title}</div>
                <div className="text-sm text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Tiers */}
      <section className="bg-[#1A0A0A] py-24 px-4">
        <div className="max-w-5xl mx-auto">
          <p className="section-label text-[#C4511F] mb-4">COMMISSION STRUCTURE</p>
          <h2 className="text-4xl font-extrabold uppercase tracking-[-0.02em] text-white mb-4">
            Earn more as you grow.
          </h2>
          <p className="text-[#6B5B55] mb-14 text-sm max-w-md">
            Your tier is based on total active merchants you&apos;ve referred. Upgrades happen automatically.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {TIERS.map((tier) => (
              <div
                key={tier.name}
                className={`rounded-xl p-7 bg-[#2A1A1A] border ${
                  tier.highlight
                    ? 'border-[#8B1A1A] ring-1 ring-[#8B1A1A]/40'
                    : 'border-[#2A1A1A]'
                }`}
              >
                {tier.highlight && (
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#8B1A1A]/20 text-[#C4511F] text-[11px] font-medium uppercase tracking-[0.08em] mb-4">
                    <Star size={10} fill="currentColor" /> Most popular
                  </div>
                )}
                <div className="text-base font-extrabold text-white uppercase tracking-[0.05em] mb-1">{tier.name}</div>
                <div className="text-xs text-[#6B5B55] uppercase tracking-[0.08em] mb-6">{tier.referrals} active referrals</div>
                <div className="text-4xl font-extrabold text-white mb-1">
                  {tier.commission}
                </div>
                <div className="text-xs text-[#9B8B85] uppercase tracking-[0.08em] mb-7">commission</div>
                <ul className="space-y-3">
                  {tier.perks.map((perk) => (
                    <li key={perk} className="flex items-start gap-2.5 text-sm text-[#9B8B85]">
                      <CheckCircle size={14} className="text-[#8B1A1A] shrink-0 mt-0.5" />
                      {perk}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Eligibility + Who thrives */}
      <section className="max-w-5xl mx-auto px-4 py-24">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-16 items-start">
          <div>
            <p className="section-label text-[#9B8B85] mb-4">REQUIREMENTS</p>
            <h2 className="text-3xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-8">
              Eligibility
            </h2>
            <ul className="space-y-4">
              {[
                'Must be a registered Unity user with verified KYC',
                'Based in a country where Unity operates',
                'Agree to Warp affiliate terms of service',
                'Must not refer yourself or existing Unity merchants',
                'No history of platform violations or disputes',
              ].map((req) => (
                <li key={req} className="flex items-start gap-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#8B1A1A] mt-2 shrink-0" />
                  {req}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="section-label text-[#9B8B85] mb-4">IDEAL FOR</p>
            <h2 className="text-3xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-8">
              Who thrives
            </h2>
            <div className="space-y-4">
              {[
                { icon: Users, title: 'Community builders', desc: 'WhatsApp admins, Facebook group owners, local event organisers.' },
                { icon: TrendingUp, title: 'Content creators', desc: 'Bloggers, YouTubers, and social influencers in lifestyle or outdoor niches.' },
                { icon: Globe, title: 'Networks', desc: 'Business associations, co-working spaces, or township economy organisers.' },
              ].map(({ icon: Icon, title, desc }) => (
                <div key={title} className="flex items-start gap-4 p-5 rounded-xl bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A]">
                  <Icon size={15} className="text-[#C4511F] shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] uppercase tracking-[0.03em] mb-1">{title}</div>
                    <div className="text-xs text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-[#FAF8F5] dark:bg-[#1A0A0A] border-t border-[#F2EDE8] dark:border-[#2A1A1A] py-24 px-4">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-start md:items-end justify-between gap-10">
          <div>
            <p className="section-label text-[#9B8B85] mb-4">GET STARTED</p>
            <h2 className="text-4xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-4 max-w-sm">
              Ready to start earning?
            </h2>
            <p className="text-[#6B5B55] dark:text-[#9B8B85] text-sm max-w-md leading-relaxed">
              Applications take under 5 minutes. Once approved by Warp, your referral link is live immediately.
            </p>
          </div>
          <div className="flex flex-col items-start md:items-end gap-3 shrink-0">
            <a
              href={WARP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-7 py-3.5 bg-[#8B1A1A] hover:bg-[#7A1616] text-white font-semibold uppercase tracking-[0.05em] text-sm rounded-xl transition-colors"
            >
              Apply now via Warp <ArrowRight size={16} />
            </a>
            <Link href="/dashboard/merchant/affiliates" className="text-xs text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors underline underline-offset-2">
              Already an ambassador? View your dashboard →
            </Link>
          </div>
        </div>
      </section>

    </div>
  )
}
