import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { LockKeyhole, Store, ShieldCheck, Hourglass } from 'lucide-react'
import { SITEMAP_ENTRIES } from '@/lib/help/sitemap-registry'
import type { SitemapEntry, SitemapSection } from '@/lib/help/types'
import { absoluteUrl, getDefaultRobotsMeta } from '@/lib/seo/config'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('help.sitemapPage')
  const title = t('metaTitle')
  const description = t('metaDescription')
  return {
    title,
    description,
    // Follows the same general indexing gate as the rest of the site
    // (src/lib/seo/config.ts) -- prepared to be indexed once
    // SEO_INDEXING_ENABLED is turned on, not indexed before then.
    alternates: { canonical: absoluteUrl('/sitemap') },
    robots: getDefaultRobotsMeta(),
    openGraph: { title, description, url: absoluteUrl('/sitemap'), type: 'website' },
  }
}

const SECTIONS: SitemapSection[] = ['public', 'user', 'merchant', 'admin']

function EntryBadges({ entry, labels }: { entry: SitemapEntry; labels: { loginRequired: string; merchant: string; adminOnly: string; providerPending: string } }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {entry.requiresLogin && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-[#6B5B55] dark:text-[#9B8B85]">
          <LockKeyhole size={10} /> {labels.loginRequired}
        </span>
      )}
      {entry.requiresMerchant && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-[#6B5B55] dark:text-[#9B8B85]">
          <Store size={10} /> {labels.merchant}
        </span>
      )}
      {entry.requiresAdmin && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#8B1A1A]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-[#8B1A1A]">
          <ShieldCheck size={10} /> {labels.adminOnly}
        </span>
      )}
      {entry.providerDependency && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-amber-700 dark:text-amber-400">
          <Hourglass size={10} /> {labels.providerPending}
        </span>
      )}
    </div>
  )
}

export default async function SitemapPage() {
  const t = await getTranslations('help.sitemapPage')
  const badgeLabels = {
    loginRequired: t('badges.loginRequired'),
    merchant: t('badges.merchant'),
    adminOnly: t('badges.adminOnly'),
    providerPending: t('badges.providerPending'),
  }
  const sectionLabels: Record<SitemapSection, string> = {
    public: t('sections.public'),
    user: t('sections.user'),
    merchant: t('sections.merchant'),
    admin: t('sections.admin'),
  }
  const sectionDescriptions: Record<SitemapSection, string> = {
    public: t('sectionDescriptions.public'),
    user: t('sectionDescriptions.user'),
    merchant: t('sectionDescriptions.merchant'),
    admin: t('sectionDescriptions.admin'),
  }

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen">
      <section className="pt-24 pb-10 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        <div className="max-w-5xl mx-auto px-6 lg:px-12">
          <p className="section-label mb-4 text-[#9B8B85]">{t('eyebrow')}</p>
          <h1 className="text-3xl sm:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-4">{t('heading')}</h1>
          <p className="text-[#6B5B55] dark:text-[#9B8B85] max-w-2xl">
            {t('introBeforeLink')} <Link href="/help" className="text-[#8B1A1A] underline">{t('helpLinkText')}</Link>{t('introAfterLink')}
          </p>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 lg:px-12 py-12 space-y-14">
        {SECTIONS.map((section) => {
          const entries = SITEMAP_ENTRIES.filter((e) => e.section === section)
          return (
            <section key={section} aria-labelledby={`sitemap-${section}`}>
              <h2 id={`sitemap-${section}`} className="text-xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-1.5">
                {sectionLabels[section]}
              </h2>
              <p className="text-sm text-[#9B8B85] mb-5">{sectionDescriptions[section]}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {entries.map((entry) => {
                  const isDynamic = entry.path.includes('[')
                  const content = (
                    <div className="h-full rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-4 hover:border-[#8B1A1A]/40 transition-colors">
                      <p className="font-semibold text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">{entry.label}</p>
                      <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-1 leading-relaxed">{entry.description}</p>
                      <p className="text-[11px] font-mono text-[#9B8B85] mt-2 truncate">{entry.path}</p>
                      <EntryBadges entry={entry} labels={badgeLabels} />
                    </div>
                  )
                  // Dynamic routes ([id]) have no single real destination to
                  // link to -- shown as a card, not a dead/placeholder link.
                  return isDynamic ? (
                    <div key={entry.id}>{content}</div>
                  ) : (
                    <Link key={entry.id} href={entry.path} className="block">
                      {content}
                    </Link>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
