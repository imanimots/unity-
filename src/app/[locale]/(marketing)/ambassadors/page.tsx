import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { CheckCircle, Users, TrendingUp, Globe, ArrowRight, Wallet, Link2, ExternalLink } from 'lucide-react'
import { absoluteUrl, isIndexingEnabled } from '@/lib/seo/config'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('merchant.ambassadors')
  const title = t('metaTitle')
  const description = t('metaDescription')
  return {
    title,
    description,
    alternates: isIndexingEnabled() ? { canonical: absoluteUrl('/ambassadors') } : undefined,
    openGraph: { title, description, url: absoluteUrl('/ambassadors'), type: 'website' },
    twitter: { card: 'summary_large_image', title, description },
  }
}

const WARP_URL = process.env.NEXT_PUBLIC_WARP_AFFILIATE_URL ?? '#'

export default async function AmbassadorsPage() {
  const t = await getTranslations('merchant.ambassadors')

  const stats = [
    { value: t('stats.costValue'), label: t('stats.costLabel') },
    { value: t('stats.linkValue'), label: t('stats.linkLabel') },
    { value: t('stats.managedByValue'), label: t('stats.managedByLabel') },
  ]
  const howItWorks = [
    { step: '01', title: t('steps.apply.title'), desc: t('steps.apply.desc') },
    { step: '02', title: t('steps.getLink.title'), desc: t('steps.getLink.desc') },
    { step: '03', title: t('steps.refer.title'), desc: t('steps.refer.desc') },
    { step: '04', title: t('steps.earn.title'), desc: t('steps.earn.desc') },
  ]
  const commissionFacts = t.raw('commissionFacts') as string[]
  const eligibility = t.raw('eligibility') as string[]
  const whoThrives = [
    { icon: Users, title: t('whoThrives.communityBuilders.title'), desc: t('whoThrives.communityBuilders.desc') },
    { icon: TrendingUp, title: t('whoThrives.contentCreators.title'), desc: t('whoThrives.contentCreators.desc') },
    { icon: Globe, title: t('whoThrives.networks.title'), desc: t('whoThrives.networks.desc') },
  ]

  return (
    <div className="min-h-screen bg-[#FAF8F5]">

      {/* Hero */}
      <section className="bg-[#1A0A0A] text-white py-[120px] px-4">
        <div className="max-w-5xl mx-auto">
          <p className="section-label text-[#C4511F] mb-6">{t('earnWithUnity')}</p>
          <h1 className="section-heading text-white mb-8 max-w-3xl">
            {t('headingLine1')}<br />{t('headingLine2')}
          </h1>
          <p className="text-[#9B8B85] text-lg max-w-xl mb-10 leading-relaxed">
            {t('heroDescription')}
          </p>
          <div className="flex flex-col sm:flex-row items-start gap-4">
            <a
              href={WARP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-7 py-3.5 bg-[#8B1A1A] hover:bg-[#7A1616] text-white font-semibold uppercase tracking-[0.05em] text-sm rounded-xl transition-colors"
            >
              {t('joinViaWarp')} <ArrowRight size={16} />
            </a>
            <p className="text-[#6B5B55] text-sm mt-3 sm:mt-3.5">{t('noCostNotice')}</p>
          </div>
        </div>
      </section>

      {/* Stats bar */}
      <section className="border-b border-[#F2EDE8] bg-white">
        <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#F2EDE8]">
          {stats.map(({ value, label }) => (
            <div key={label} className="py-8 px-6 text-center">
              <div className="text-3xl font-extrabold text-[#1A0A0A] mb-1">{value}</div>
              <div className="text-sm text-[#6B5B55] uppercase tracking-[0.05em]">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-5xl mx-auto px-4 py-24">
        <p className="section-label text-[#9B8B85] mb-4">{t('processLabel')}</p>
        <h2 className="text-4xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] mb-14">
          {t('howItWorksHeading')}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {howItWorks.map(({ step, title, desc }) => (
            <div key={step} className="flex gap-5 p-6 rounded-xl border border-[#F2EDE8] bg-white">
              <div className="text-[#8B1A1A] font-extrabold text-xs font-mono shrink-0 pt-1 tracking-[0.1em]">{step}</div>
              <div>
                <div className="font-semibold text-[#1A0A0A] mb-2 uppercase tracking-[0.03em] text-sm">{title}</div>
                <div className="text-sm text-[#6B5B55] leading-relaxed">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Commission — honest framing: Warp owns this program's actual
          commission tiers/rates/payout schedule, not Unity, so this
          section states what's actually true rather than inventing
          specific numbers Unity doesn't set or control. */}
      <section className="bg-[#1A0A0A] py-24 px-4">
        <div className="max-w-5xl mx-auto">
          <p className="section-label text-[#C4511F] mb-4">{t('commissionStructureLabel')}</p>
          <h2 className="text-4xl font-extrabold uppercase tracking-[-0.02em] text-white mb-6">
            {t('earnMoreHeading')}
          </h2>
          <p className="text-[#9B8B85] mb-10 text-sm max-w-xl leading-relaxed">
            {t('commissionExplainer')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {commissionFacts.map((fact, i) => {
              const Icon = [Wallet, Link2, ExternalLink][i] ?? CheckCircle
              return (
                <div key={fact} className="rounded-xl p-6 bg-[#2A1A1A] border border-[#2A1A1A]">
                  <Icon size={18} className="text-[#C4511F] mb-4" />
                  <p className="text-sm text-[#9B8B85] leading-relaxed">{fact}</p>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* Eligibility + Who thrives */}
      <section className="max-w-5xl mx-auto px-4 py-24">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-16 items-start">
          <div>
            <p className="section-label text-[#9B8B85] mb-4">{t('requirementsLabel')}</p>
            <h2 className="text-3xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] mb-8">
              {t('eligibilityHeading')}
            </h2>
            <ul className="space-y-4">
              {eligibility.map((req) => (
                <li key={req} className="flex items-start gap-3 text-sm text-[#6B5B55] leading-relaxed">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#8B1A1A] mt-2 shrink-0" />
                  {req}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="section-label text-[#9B8B85] mb-4">{t('idealForLabel')}</p>
            <h2 className="text-3xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] mb-8">
              {t('whoThrivesHeading')}
            </h2>
            <div className="space-y-4">
              {whoThrives.map(({ icon: Icon, title, desc }) => (
                <div key={title} className="flex items-start gap-4 p-5 rounded-xl bg-white border border-[#F2EDE8]">
                  <Icon size={15} className="text-[#C4511F] shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold text-[#1A0A0A] uppercase tracking-[0.03em] mb-1">{title}</div>
                    <div className="text-xs text-[#6B5B55] leading-relaxed">{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-[#FAF8F5] border-t border-[#F2EDE8] py-24 px-4">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-start md:items-end justify-between gap-10">
          <div>
            <p className="section-label text-[#9B8B85] mb-4">{t('getStartedLabel')}</p>
            <h2 className="text-4xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] mb-4 max-w-sm">
              {t('readyHeading')}
            </h2>
            <p className="text-[#6B5B55] text-sm max-w-md leading-relaxed">
              {t('readyDesc')}
            </p>
          </div>
          <div className="flex flex-col items-start md:items-end gap-3 shrink-0">
            <a
              href={WARP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-7 py-3.5 bg-[#8B1A1A] hover:bg-[#7A1616] text-white font-semibold uppercase tracking-[0.05em] text-sm rounded-xl transition-colors"
            >
              {t('applyNowViaWarp')} <ArrowRight size={16} />
            </a>
            <Link href="/dashboard/merchant/affiliates" className="text-xs text-[#9B8B85] hover:text-[#1A0A0A] transition-colors underline underline-offset-2">
              {t('alreadyAmbassador')}
            </Link>
          </div>
        </div>
      </section>

    </div>
  )
}
