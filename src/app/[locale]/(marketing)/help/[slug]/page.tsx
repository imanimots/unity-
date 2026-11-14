import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowRight, Hourglass, ShieldCheck, Store, LockKeyhole } from 'lucide-react'
import { HELP_TASKS } from '@/lib/help/task-registry'
import { CATEGORY_LABELS, ROLE_LABELS } from '@/lib/help/types'
import { absoluteUrl, getDefaultRobotsMeta, PERMANENT_NOINDEX } from '@/lib/seo/config'

interface PageProps {
  params: Promise<{ slug: string }>
}

export function generateStaticParams() {
  return HELP_TASKS.map((t) => ({ slug: t.slug }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const task = HELP_TASKS.find((t) => t.slug === slug)
  if (!task) {
    const t = await getTranslations('help.helpCenterPage')
    return { title: t('metaTitle'), robots: PERMANENT_NOINDEX }
  }
  const title = `${task.iWantTo} — Unity Help Center`
  return {
    title,
    description: task.summary,
    alternates: { canonical: absoluteUrl(`/help/${task.slug}`) },
    robots: getDefaultRobotsMeta(),
    openGraph: { title, description: task.summary, url: absoluteUrl(`/help/${task.slug}`), type: 'article' },
  }
}

// Content, not chrome -- same precedent as the task registry's own
// summary/steps/whatHappensNext text -- so this stays English-authoritative
// rather than moving into help.json.
const PROVIDER_LABELS: Record<string, string> = {
  tradesafe: 'Real payment/escrow provider (TradeSafe) integration pending',
  'bob-go': 'Real logistics/courier provider (Bob Go) integration pending',
  kyc: 'Real automated identity-verification provider integration pending — reviewed manually today',
}

export default async function HelpTaskPage({ params }: PageProps) {
  const { slug } = await params
  const task = HELP_TASKS.find((t) => t.slug === slug)
  if (!task) notFound()

  const t = await getTranslations('help.taskPage')

  const related = task.relatedTaskIds
    .map((id) => HELP_TASKS.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen">
      <section className="pt-24 pb-10 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        <div className="max-w-3xl mx-auto px-6 lg:px-12">
          <nav aria-label="Breadcrumb" className="text-xs text-[#9B8B85] mb-4">
            <Link href="/help" className="hover:text-[#8B1A1A]">{t('breadcrumbHelpCenter')}</Link>
            <span className="mx-1.5">/</span>
            <span>{CATEGORY_LABELS[task.category]}</span>
          </nav>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-4">{task.iWantTo}</h1>
          <p className="text-[#6B5B55] dark:text-[#9B8B85]">{task.summary}</p>

          <div className="flex flex-wrap gap-1.5 mt-4">
            {task.role.map((r) => (
              <span key={r} className="inline-flex items-center gap-1 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[#6B5B55] dark:text-[#9B8B85]">
                {r === 'admin' && <ShieldCheck size={11} />}
                {r === 'merchant' && <Store size={11} />}
                {ROLE_LABELS[r]}
              </span>
            ))}
            {task.providerDependency && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/30 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                <Hourglass size={11} /> {task.status === 'pending-provider' ? t('providerPendingBadge') : t('partialProviderBadge')}
              </span>
            )}
          </div>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-6 lg:px-12 py-12 space-y-10">
        {task.providerDependency && (
          <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/10 p-4 text-sm text-amber-800 dark:text-amber-300">
            {PROVIDER_LABELS[task.providerDependency]}. {t('providerBannerSuffix')}
          </div>
        )}

        {task.prerequisites.length > 0 && (
          <section>
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">{t('beforeYouStart')}</h2>
            <ul className="space-y-1.5">
              {task.prerequisites.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
                  <LockKeyhole size={14} className="mt-0.5 text-[#9B8B85] shrink-0" /> {p}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">{t('steps')}</h2>
          <ol className="space-y-3">
            {task.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
                <span className="shrink-0 w-6 h-6 rounded-full bg-[#8B1A1A] text-white text-xs font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">{t('whereToGo')}</h2>
          <div className="flex flex-wrap gap-2">
            {task.routes.map((r) =>
              r.path.includes('[') ? (
                <span key={r.path} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]">
                  {r.label}
                </span>
              ) : (
                <Link
                  key={r.path}
                  href={r.path}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors"
                >
                  {r.label} <ArrowRight size={14} />
                </Link>
              )
            )}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">{t('whatHappensNext')}</h2>
          <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] leading-relaxed">{task.whatHappensNext}</p>
        </section>

        {task.commonIssues.length > 0 && (
          <section>
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">{t('commonIssues')}</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              {task.commonIssues.map((issue, i) => (
                <li key={i} className="text-sm text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">{issue}</li>
              ))}
            </ul>
          </section>
        )}

        {related.length > 0 && (
          <section>
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">{t('relatedTasks')}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link
                  key={r.id}
                  href={`/help/${r.slug}`}
                  className="block rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-4 hover:border-[#8B1A1A]/40 transition-colors"
                >
                  <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{r.iWantTo}</p>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
          <Link href="/help" className="text-sm text-[#8B1A1A] underline">{t('backToHelpCenter')}</Link>
        </div>
      </div>
    </div>
  )
}
