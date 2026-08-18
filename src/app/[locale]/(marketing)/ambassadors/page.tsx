import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { CheckCircle, Users, TrendingUp, Globe, ArrowRight, Star } from 'lucide-react'
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
    { value: t('stats.payoutScheduleValue'), label: t('stats.payoutSchedule') },
    { value: t('stats.trackingValue'), label: t('stats.trackingLabel') },
  ]
  const howItWorks = [
    { step: '01', title: t('steps.apply.title'), desc: t('steps.apply.desc') },
    { step: '02', title: t('steps.getLink.title'), desc: t('steps.getLink.desc') },
    { step: '03', title: t('steps.refer.title'), desc: t('steps.refer.desc') },
    { step: '04', title: t('steps.earn.title'), desc: t('steps.earn.desc') },
  ]
  const tiers = [
    { key: 'starter', highlight: false },
    { key: 'growth', highlight: true },
    { key: 'elite', highlight: false },
  ] as const
  const eligibility = t.raw('eligibility') as string[]
  const whoThrives = [
    { icon: Users, title: t('whoThrives.communityBuilders.title'), desc: t('whoThrives.communityBuilders.desc') },
    { icon: TrendingUp, title: t('whoThrives.contentCreators.title'), desc: t('whoThrives.contentCreators.desc') },
    { icon: Globe, title: t('whoThrives.networks.title'), desc: t('whoThrives.networks.desc') },
  ]

  return (
    <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A]">

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
      <section className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010]">
        <div className="max-w-5xl mx-auto grid grid-cols-3 divide-x divide-[#F2EDE8] dark:divide-[#2A1A1A]">
          <div className="py-8 px-6 text-center">
            <div className="text-3xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] mb-1">12%</div>
            <div className="text-sm text-[#6B5B55] dark:text-[#9B8B85] uppercase tracking-[0.05em]">{t('stats.maxCommission')}</div>
          </div>
          {stats.map(({ value, label }) => (
            <div key={label} className="py-8 px-6 text-center">
              <div className="text-3xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] mb-1">{value}</div>
              <div className="text-sm text-[#6B5B55] dark:text-[#9B8B85] uppercase tracking-[0.05em]">{label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-5xl mx-auto px-4 py-24">
        <p className="section-label text-[#9B8B85] mb-4">{t('processLabel')}</p>
        <h2 className="text-4xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-14">
          {t('howItWorksHeading')}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {howItWorks.map(({ step, title, desc }) => (
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
          <p className="section-label text-[#C4511F] mb-4">{t('commissionStructureLabel')}</p>
          <h2 className="text-4xl font-extrabold uppercase tracking-[-0.02em] text-white mb-4">
            {t('earnMoreHeading')}
          </h2>
          <p className="text-[#6B5B55] mb-14 text-sm max-w-md">
            {t('tierBasisNotice')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {tiers.map(({ key, highlight }) => {
              const perks = t.raw(`tiers.${key}.perks`) as string[]
              return (
                <div
                  key={key}
                  className={`rounded-xl p-7 bg-[#2A1A1A] border ${
                    highlight
                      ? 'border-[#8B1A1A] ring-1 ring-[#8B1A1A]/40'
                      : 'border-[#2A1A1A]'
                  }`}
                >
                  {highlight && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#8B1A1A]/20 text-[#C4511F] text-[11px] font-medium uppercase tracking-[0.08em] mb-4">
                      <Star size={10} fill="currentColor" /> {t('mostPopular')}
                    </div>
                  )}
                  <div className="text-base font-extrabold text-white uppercase tracking-[0.05em] mb-1">{t(`tiers.${key}.name`)}</div>
                  <div className="text-xs text-[#6B5B55] uppercase tracking-[0.08em] mb-6">{t(`tiers.${key}.referrals`)} {t('activeReferrals')}</div>
                  <div className="text-4xl font-extrabold text-white mb-1">
                    {t(`tiers.${key}.commission`)}
                  </div>
                  <div className="text-xs text-[#9B8B85] uppercase tracking-[0.08em] mb-7">{t('commissionSuffix')}</div>
                  <ul className="space-y-3">
                    {perks.map((perk) => (
                      <li key={perk} className="flex items-start gap-2.5 text-sm text-[#9B8B85]">
                        <CheckCircle size={14} className="text-[#8B1A1A] shrink-0 mt-0.5" />
                        {perk}
                      </li>
                    ))}
                  </ul>
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
            <h2 className="text-3xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-8">
              {t('eligibilityHeading')}
            </h2>
            <ul className="space-y-4">
              {eligibility.map((req) => (
                <li key={req} className="flex items-start gap-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#8B1A1A] mt-2 shrink-0" />
                  {req}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="section-label text-[#9B8B85] mb-4">{t('idealForLabel')}</p>
            <h2 className="text-3xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-8">
              {t('whoThrivesHeading')}
            </h2>
            <div className="space-y-4">
              {whoThrives.map(({ icon: Icon, title, desc }) => (
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
            <p className="section-label text-[#9B8B85] mb-4">{t('getStartedLabel')}</p>
            <h2 className="text-4xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-4 max-w-sm">
              {t('readyHeading')}
            </h2>
            <p className="text-[#6B5B55] dark:text-[#9B8B85] text-sm max-w-md leading-relaxed">
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
            <Link href="/dashboard/merchant/affiliates" className="text-xs text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors underline underline-offset-2">
              {t('alreadyAmbassador')}
            </Link>
          </div>
        </div>
      </section>

    </div>
  )
}
