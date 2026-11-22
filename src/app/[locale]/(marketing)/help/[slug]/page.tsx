import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowRight, Hourglass, ShieldCheck, Store, LockKeyhole, BookOpen } from 'lucide-react'
import { HELP_TASKS } from '@/lib/help/task-registry'
import { LEARN_ARTICLES } from '@/lib/help/learn-registry'
import { CATEGORY_LABELS, ROLE_LABELS } from '@/lib/help/types'
import { SupportCard } from '@/components/help/support-card'
import { absoluteUrl, getDefaultRobotsMeta, PERMANENT_NOINDEX } from '@/lib/seo/config'

interface PageProps {
  params: Promise<{ slug: string }>
}

export function generateStaticParams() {
  return [...HELP_TASKS.map((t) => ({ slug: t.slug })), ...LEARN_ARTICLES.map((a) => ({ slug: a.slug }))]
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const task = HELP_TASKS.find((t) => t.slug === slug)
  const learn = !task ? LEARN_ARTICLES.find((a) => a.slug === slug) : undefined
  if (!task && !learn) {
    const t = await getTranslations('help.helpCenterPage')
    return { title: t('metaTitle'), robots: PERMANENT_NOINDEX }
  }
  const heading = task ? task.iWantTo : learn!.title
  const summary = task ? task.summary : learn!.summary
  const title = `${heading} — Unity Help Center`
  return {
    title,
    description: summary,
    alternates: { canonical: absoluteUrl(`/help/${slug}`) },
    robots: getDefaultRobotsMeta(),
    openGraph: { title, description: summary, url: absoluteUrl(`/help/${slug}`), type: 'article' },
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
  const learn = !task ? LEARN_ARTICLES.find((a) => a.slug === slug) : undefined
  if (!task && !learn) notFound()

  if (learn) {
    return <LearnArticlePage article={learn} />
  }
  if (!task) notFound()

  const t = await getTranslations('help.taskPage')

  const related = task.relatedTaskIds
    .map((id) => HELP_TASKS.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
  const relatedLearn = (task.relatedLearnIds ?? [])
    .map((id) => LEARN_ARTICLES.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))

  return (
    <div className="bg-[#FAF8F5] min-h-screen">
      <section className="pt-24 pb-10 border-b border-[#F2EDE8]">
        <div className="max-w-5xl mx-auto px-6 lg:px-12">
          <nav aria-label="Breadcrumb" className="text-xs text-[#9B8B85] mb-4">
            <Link href="/help" className="hover:text-[#8B1A1A]">{t('breadcrumbHelpCenter')}</Link>
            <span className="mx-1.5">/</span>
            <span>{CATEGORY_LABELS[task.category]}</span>
          </nav>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#1A0A0A] tracking-tight mb-4">{task.iWantTo}</h1>
          <p className="text-[#6B5B55]">{task.summary}</p>

          <div className="flex flex-wrap gap-1.5 mt-4">
            {task.role.map((r) => (
              <span key={r} className="inline-flex items-center gap-1 rounded-full bg-[#F2EDE8] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[#6B5B55]">
                {r === 'admin' && <ShieldCheck size={11} />}
                {r === 'merchant' && <Store size={11} />}
                {ROLE_LABELS[r]}
              </span>
            ))}
            {task.providerDependency && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                <Hourglass size={11} /> {task.status === 'pending-provider' ? t('providerPendingBadge') : t('partialProviderBadge')}
              </span>
            )}
          </div>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 lg:px-12 py-12 lg:grid lg:grid-cols-[1fr_260px] lg:gap-10 lg:items-start">
      <div className="space-y-10 min-w-0">
        {task.providerDependency && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            {PROVIDER_LABELS[task.providerDependency]}. {t('providerBannerSuffix')}
          </div>
        )}

        {task.prerequisites.length > 0 && (
          <section>
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">{t('beforeYouStart')}</h2>
            <ul className="space-y-1.5">
              {task.prerequisites.map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-[#1A0A0A]">
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
              <li key={i} className="flex items-start gap-3 text-sm text-[#1A0A0A]">
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
                <span key={r.path} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold border border-[#E8E0D8] text-[#6B5B55]">
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
          <p className="text-sm text-[#1A0A0A] leading-relaxed">{task.whatHappensNext}</p>
        </section>

        {task.commonIssues.length > 0 && (
          <section>
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">{t('commonIssues')}</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              {task.commonIssues.map((issue, i) => (
                <li key={i} className="text-sm text-[#6B5B55] leading-relaxed">{issue}</li>
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
                  className="block rounded-xl border border-[#F2EDE8] bg-white p-4 hover:border-[#8B1A1A]/40 transition-colors"
                >
                  <p className="text-sm font-semibold text-[#1A0A0A]">{r.iWantTo}</p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {relatedLearn.length > 0 && (
          <section>
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">Learn more about this</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {relatedLearn.map((a) => (
                <Link
                  key={a.id}
                  href={`/help/${a.slug}`}
                  className="flex items-start gap-2 rounded-xl border border-[#8B1A1A]/20 bg-[#8B1A1A]/[0.03] p-4 hover:border-[#8B1A1A]/40 transition-colors"
                >
                  <BookOpen size={15} className="text-[#8B1A1A] mt-0.5 shrink-0" />
                  <p className="text-sm font-semibold text-[#1A0A0A]">{a.title}</p>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="pt-4 border-t border-[#F2EDE8]">
          <Link href="/help" className="text-sm text-[#8B1A1A] underline">{t('backToHelpCenter')}</Link>
        </div>

        <div className="lg:hidden">
          <SupportCard />
        </div>
      </div>

      <div className="hidden lg:block sticky top-24">
        <SupportCard />
      </div>
      </div>
    </div>
  )
}

/**
 * Renders a LearnArticle -- the explanatory/conceptual counterpart to
 * the procedural HelpTaskPage above. No prerequisites/steps/routes
 * (LearnArticle has none -- see types.ts) -- instead: an optional
 * quick-answer summary, prose sections, an optional worked example,
 * and (for the Glossary only) a flat term/definition list.
 */
function LearnArticlePage({ article }: { article: import('@/lib/help/types').LearnArticle }) {
  const relatedLearn = (article.relatedLearnIds ?? [])
    .map((id) => LEARN_ARTICLES.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
  const relatedTasks = (article.relatedTaskIds ?? [])
    .map((id) => HELP_TASKS.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))

  return (
    <div className="bg-[#FAF8F5] min-h-screen">
      <section className="pt-24 pb-10 border-b border-[#F2EDE8]">
        <div className="max-w-5xl mx-auto px-6 lg:px-12">
          <nav aria-label="Breadcrumb" className="text-xs text-[#9B8B85] mb-4">
            <Link href="/help" className="hover:text-[#8B1A1A]">Help Center</Link>
            <span className="mx-1.5">/</span>
            <span>{CATEGORY_LABELS[article.category]}</span>
          </nav>
          <span className="inline-flex items-center gap-1 rounded-full bg-[#8B1A1A]/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.05em] text-[#8B1A1A] mb-3">
            <BookOpen size={11} /> Learn
          </span>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#1A0A0A] tracking-tight mb-4">{article.title}</h1>
          <p className="text-[#6B5B55]">{article.summary}</p>
          <div className="flex flex-wrap gap-1.5 mt-4">
            {article.role.map((r) => (
              <span key={r} className="inline-flex items-center gap-1 rounded-full bg-[#F2EDE8] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.04em] text-[#6B5B55]">
                {r === 'admin' && <ShieldCheck size={11} />}
                {r === 'merchant' && <Store size={11} />}
                {ROLE_LABELS[r]}
              </span>
            ))}
          </div>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-6 lg:px-12 py-12 lg:grid lg:grid-cols-[1fr_260px] lg:gap-10 lg:items-start">
      <div className="space-y-10 min-w-0">
        {article.quickAnswer && article.quickAnswer.length > 0 && (
          <section className="rounded-xl border border-[#8B1A1A]/20 bg-[#8B1A1A]/[0.03] p-5">
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#8B1A1A] mb-3">Quick answer</h2>
            <ul className="space-y-1.5">
              {article.quickAnswer.map((point, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-[#1A0A0A] leading-relaxed">
                  <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-[#8B1A1A] mt-1.5" /> {point}
                </li>
              ))}
            </ul>
          </section>
        )}

        {article.sections.map((section, i) => (
          <section key={i}>
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">{section.heading}</h2>
            <div className="space-y-3">
              {section.body.map((para, j) => (
                <p key={j} className="text-sm text-[#1A0A0A] leading-relaxed">{para}</p>
              ))}
            </div>
          </section>
        ))}

        {article.definitions && article.definitions.length > 0 && (
          <section>
            <dl className="divide-y divide-[#F2EDE8]">
              {article.definitions.map((d) => (
                <div key={d.term} className="py-3">
                  <dt className="text-sm font-bold text-[#1A0A0A]">{d.term}</dt>
                  <dd className="text-sm text-[#6B5B55] mt-0.5 leading-relaxed">{d.definition}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {article.example && article.example.length > 0 && (
          <section className="rounded-xl border border-[#F2EDE8] bg-white p-5">
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">Example</h2>
            <div className="space-y-2">
              {article.example.map((ex, i) => (
                <p key={i} className="text-sm text-[#1A0A0A]">
                  <span className="font-semibold text-[#6B5B55]">{ex.label}:</span> {ex.text}
                </p>
              ))}
            </div>
          </section>
        )}

        {(relatedLearn.length > 0 || relatedTasks.length > 0) && (
          <section>
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-3">Related</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {relatedTasks.map((r) => (
                <Link
                  key={r.id}
                  href={`/help/${r.slug}`}
                  className="block rounded-xl border border-[#F2EDE8] bg-white p-4 hover:border-[#8B1A1A]/40 transition-colors"
                >
                  <p className="text-sm font-semibold text-[#1A0A0A]">{r.iWantTo}</p>
                </Link>
              ))}
              {relatedLearn.map((a) => (
                <Link
                  key={a.id}
                  href={`/help/${a.slug}`}
                  className="flex items-start gap-2 rounded-xl border border-[#8B1A1A]/20 bg-[#8B1A1A]/[0.03] p-4 hover:border-[#8B1A1A]/40 transition-colors"
                >
                  <BookOpen size={15} className="text-[#8B1A1A] mt-0.5 shrink-0" />
                  <p className="text-sm font-semibold text-[#1A0A0A]">{a.title}</p>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="pt-4 border-t border-[#F2EDE8]">
          <Link href="/help" className="text-sm text-[#8B1A1A] underline">Back to Help Center</Link>
        </div>

        <div className="lg:hidden">
          <SupportCard />
        </div>
      </div>

      <div className="hidden lg:block sticky top-24">
        <SupportCard />
      </div>
      </div>
    </div>
  )
}
