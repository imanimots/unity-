import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getTranslations, getMessages } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { HELP_TASKS } from '@/lib/help/task-registry'
import { HelpBrowser } from '@/components/help/help-browser'
import { absoluteUrl, getDefaultRobotsMeta } from '@/lib/seo/config'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('help.helpCenterPage')
  const title = t('metaTitle')
  const description = t('metaDescription')
  return {
    title,
    description,
    alternates: { canonical: absoluteUrl('/help') },
    robots: getDefaultRobotsMeta(),
    openGraph: { title, description, url: absoluteUrl('/help'), type: 'website' },
  }
}

export default async function HelpCenterPage() {
  const t = await getTranslations('help.helpCenterPage')

  // Narrowly scoped nested provider (same pattern as looking-for/new) --
  // HelpBrowser is a Client Component living under the (marketing) layout,
  // which has no wide i18n provider by design. Scoped to just the slice it
  // needs, not the full loader.
  const messages = await getMessages()
  const scoped = { help: { helpCenterPage: messages.help.helpCenterPage } }

  return (
    <div className="bg-[#FAF8F5] min-h-screen">
      <section className="pt-24 pb-10">
        <div className="max-w-2xl mx-auto px-6 text-center">
          <span className="inline-block mb-5 px-3 py-1 rounded-full bg-[#8B1A1A]/10 text-[#8B1A1A] text-xs font-bold uppercase tracking-[0.08em]">
            {t('badge')}
          </span>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[#1A0A0A] tracking-tight mb-3">{t('heading')}</h1>
          <p className="text-[#6B5B55] mb-1">{t('subheading')}</p>
          <p className="text-sm text-[#9B8B85]">
            {t('sitemapHintBeforeLink')} <Link href="/sitemap" className="text-[#8B1A1A] underline">{t('sitemapLinkText')}</Link>{t('sitemapHintAfterLink')}
          </p>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6 lg:px-12 py-6 pb-16">
        <NextIntlClientProvider messages={scoped}>
          <HelpBrowser tasks={HELP_TASKS} />
        </NextIntlClientProvider>
      </div>
    </div>
  )
}
