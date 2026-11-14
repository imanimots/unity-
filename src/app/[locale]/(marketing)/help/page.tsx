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
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen">
      <section className="pt-24 pb-10 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        <div className="max-w-5xl mx-auto px-6 lg:px-12">
          <p className="section-label mb-4 text-[#9B8B85]">{t('eyebrow')}</p>
          <h1 className="text-3xl sm:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-4">{t('heading')}</h1>
          <p className="text-[#6B5B55] dark:text-[#9B8B85] max-w-2xl">
            {t('introBeforeLink')} <Link href="/sitemap" className="text-[#8B1A1A] underline">{t('sitemapLinkText')}</Link>{t('introAfterLink')}
          </p>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 lg:px-12 py-12">
        <NextIntlClientProvider messages={scoped}>
          <HelpBrowser tasks={HELP_TASKS} />
        </NextIntlClientProvider>
      </div>
    </div>
  )
}
