import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ArrowRight, CheckCircle2, Clock, Info } from 'lucide-react'
import { getLegalDocument, type LegalDocument } from '@/lib/legal/registry'
import { formatDate } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'

function fmtDate(iso: string, locale: Locale) {
  return formatDate(iso, locale)
}

/**
 * Shared chrome for every legal/trust page (Step 7, refined E47 Phase 5/6
 * for the editorial/legal page family): one primary heading (the document
 * title), a version/effective-date/status badge row sourced from the
 * registry (never hand-typed per page, so a page can never silently drift
 * from its own registry entry), the body in a single white editorial
 * card for better reading rhythm, readable line length (prose
 * max-width), print-friendly (no navigation chrome inside the printable
 * area), a curated "Related policies" block (navigation only -- see
 * LegalDocument.relatedSlugs, never touches the legal body itself), and
 * a real Contact CTA. `children` supplies the document body -- each page
 * is responsible for its own heading hierarchy below the h1 (h2
 * sections via <LegalSection>). The legal body text itself is never
 * rewritten here, in any locale -- only the chrome around it changed.
 */
export function LegalPageLayout({ doc, children }: { doc: LegalDocument; children: React.ReactNode }) {
  const locale = useLocale() as Locale
  const t = useTranslations('legal')

  const related = doc.relatedSlugs
    .map((slug) => getLegalDocument(slug))
    .filter((d): d is LegalDocument => Boolean(d))

  return (
    <div className="bg-[#FAF8F5] min-h-screen print:bg-white">
      <section className="pt-24 pb-8 print:pt-4">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2 print:hidden">{t('legalAndTrust')}</p>
          <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] tracking-tight mb-4">{doc.title}</h1>

          <div className="flex flex-wrap items-center gap-2 print:mb-2">
            <span className="rounded-full bg-[#F2EDE8] px-2.5 py-1 text-xs font-medium text-[#6B5B55]">{t('version', { version: doc.version })}</span>
            <span className="rounded-full bg-[#F2EDE8] px-2.5 py-1 text-xs font-medium text-[#6B5B55]">{t('effective', { date: fmtDate(doc.effectiveDate, locale) })}</span>
            <span className="rounded-full bg-[#F2EDE8] px-2.5 py-1 text-xs font-medium text-[#6B5B55]">{t('lastUpdated', { date: fmtDate(doc.lastUpdated, locale) })}</span>
            {doc.status === 'draft' ? (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold uppercase tracking-wide">
                <Clock size={11} /> {t('draftStatus')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-100 text-green-700 text-xs font-semibold uppercase tracking-wide">
                <CheckCircle2 size={11} /> {t('approvedStatus')}
              </span>
            )}
          </div>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pb-16 print:pb-4">
        {/*
          Legal fallback (binding requirement): localized chrome + an explicit
          localized notice that the authoritative text below is currently
          English-only + the actual English legal body, unchanged. Never a
          translated legal document -- `children` (the legal prose itself) is
          never touched here, in any locale, by design.
        */}
        {locale !== 'en-ZA' && (
          <div className="mb-6 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 print:hidden">
            <Info size={16} className="shrink-0 mt-0.5" />
            <span>{t('translationNotice')}</span>
          </div>
        )}

        <div className="rounded-2xl border border-[#F2EDE8] bg-white p-6 sm:p-10 print:border-0 print:p-0 print:rounded-none">
          <div className="prose-legal text-sm text-[#1A0A0A] leading-relaxed max-w-[65ch] space-y-6">
            {children}
          </div>
        </div>

        {related.length > 0 && (
          <div className="mt-10 print:hidden">
            <h2 className="text-sm font-extrabold uppercase tracking-[0.05em] text-[#9B8B85] mb-4">{t('relatedPolicies')}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={r.route}
                  className="block rounded-xl border border-[#F2EDE8] bg-white p-4 hover:border-[#8B1A1A]/40 transition-colors"
                >
                  <p className="text-sm font-semibold text-[#1A0A0A]">{r.title}</p>
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="mt-10 pt-6 border-t border-[#F2EDE8] print:hidden">
          <Link
            href="/contact"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#8B1A1A] text-[#8B1A1A] text-sm font-semibold hover:bg-[#8B1A1A] hover:text-white transition-colors"
          >
            {t('contactCta')} <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  )
}

/** Consistent h2 styling for legal page sections -- keeps heading hierarchy identical across all 12 pages. */
export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-extrabold uppercase tracking-wide text-[#1A0A0A] mb-2 mt-8 first:mt-0">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

/**
 * A visually distinct callout for a legal page's own introductory notice
 * (e.g. "this is a draft, published for public test") -- E47 Phase 5's
 * "notices/callouts" requirement. Wraps existing intro prose in a
 * visual frame only; never changes the words themselves.
 */
export function LegalNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-[#E8E0D8] bg-[#FAF8F5] px-4 py-3.5 text-sm text-[#6B5B55] print:border print:bg-white">
      <Info size={16} className="shrink-0 mt-0.5 text-[#9B8B85]" />
      <div>{children}</div>
    </div>
  )
}
