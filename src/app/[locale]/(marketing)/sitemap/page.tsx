import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { LockKeyhole, Store, ShieldCheck, Hourglass, Globe, User, ChevronDown } from 'lucide-react'
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
// Public/User open by default (what most visitors want first); Merchant/
// Admin collapsed -- a real scan aid now that Admin alone has 28 entries,
// per the brief's "collapsible/grouped sections where useful."
const DEFAULT_OPEN: Record<SitemapSection, boolean> = { public: true, user: true, merchant: false, admin: false }
const SECTION_ICON: Record<SitemapSection, typeof Globe> = { public: Globe, user: User, merchant: Store, admin: ShieldCheck }

function EntryBadges({ entry, labels }: { entry: SitemapEntry; labels: { loginRequired: string; merchant: string; adminOnly: string; providerPending: string } }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {entry.requiresLogin && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#F2EDE8] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-[#6B5B55]">
          <LockKeyhole size={10} /> {labels.loginRequired}
        </span>
      )}
      {entry.requiresMerchant && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#F2EDE8] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-[#6B5B55]">
          <Store size={10} /> {labels.merchant}
        </span>
      )}
      {entry.requiresAdmin && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#8B1A1A]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-[#8B1A1A]">
          <ShieldCheck size={10} /> {labels.adminOnly}
        </span>
      )}
      {entry.providerDependency && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] text-amber-700">
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
    <div className="bg-[#FAF8F5] min-h-screen">
      <section className="pt-24 pb-10 border-b border-[#F2EDE8]">
        <div className="max-w-2xl mx-auto px-6 text-center">
          <span className="inline-block mb-5 px-3 py-1 rounded-full bg-[#8B1A1A]/10 text-[#8B1A1A] text-xs font-bold uppercase tracking-[0.08em]">
            {t('eyebrow')}
          </span>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[#1A0A0A] tracking-tight mb-3">{t('heading')}</h1>
          <p className="text-[#6B5B55]">
            {t('introBeforeLink')} <Link href="/help" className="text-[#8B1A1A] underline">{t('helpLinkText')}</Link>{t('introAfterLink')}
          </p>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 lg:px-12 py-12 space-y-4">
        {SECTIONS.map((section) => {
          const entries = SITEMAP_ENTRIES.filter((e) => e.section === section)
          const Icon = SECTION_ICON[section]
          return (
            <details key={section} open={DEFAULT_OPEN[section]} className="group rounded-2xl border border-[#F2EDE8] bg-white overflow-hidden">
              <summary className="flex items-center gap-3 p-5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <div className="w-9 h-9 rounded-full bg-[#8B1A1A]/10 flex items-center justify-center shrink-0">
                  <Icon size={16} className="text-[#8B1A1A]" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-bold text-[#1A0A0A]">{sectionLabels[section]}</h2>
                  <p className="text-xs text-[#9B8B85]">{sectionDescriptions[section]} · {t('pageCount', { count: entries.length })}</p>
                </div>
                <ChevronDown size={18} className="text-[#9B8B85] shrink-0 transition-transform group-open:rotate-180" />
              </summary>

              <div className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {entries.map((entry) => {
                  const isDynamic = entry.path.includes('[')
                  const content = (
                    <div className="h-full rounded-xl border border-[#F2EDE8] bg-[#FAF8F5] p-4 hover:border-[#8B1A1A]/40 transition-colors">
                      <p className="font-semibold text-sm text-[#1A0A0A]">{entry.label}</p>
                      <p className="text-xs text-[#6B5B55] mt-1 leading-relaxed">{entry.description}</p>
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
            </details>
          )
        })}
      </div>
    </div>
  )
}
