import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { LegalDocument } from '@/lib/legal/registry'
import { formatDate } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'

function fmtDate(iso: string, locale: Locale) {
  return formatDate(iso, locale)
}

/**
 * Shared chrome for every legal/trust page (Step 7) -- one primary
 * heading (the document title), a version/effective-date/status badge row
 * sourced from the registry (never hand-typed per page, so a page can
 * never silently drift from its own registry entry), readable line length
 * (prose max-width), print-friendly (no navigation chrome inside the
 * printable area), and a link back to the full legal index via the
 * footer. `children` supplies the document body -- each page is
 * responsible for its own heading hierarchy below the h1 (h2 sections).
 */
export function LegalPageLayout({ doc, children }: { doc: LegalDocument; children: React.ReactNode }) {
  const locale = useLocale() as Locale
  const t = useTranslations('legal')

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 print:py-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2 print:hidden">Legal &amp; Trust</p>
      <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-4">{doc.title}</h1>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-8 text-xs text-[#6B5B55] dark:text-[#9B8B85] print:mb-4">
        <span>Version {doc.version}</span>
        <span>Effective {fmtDate(doc.effectiveDate, locale)}</span>
        <span>Last updated {fmtDate(doc.lastUpdated, locale)}</span>
        {doc.status === 'draft' ? (
          <span className="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-semibold uppercase tracking-wide">
            Draft — pending legal review
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-semibold uppercase tracking-wide">
            Approved
          </span>
        )}
      </div>

      {/*
        Legal fallback (binding requirement): localized chrome + an explicit
        localized notice that the authoritative text below is currently
        English-only + the actual English legal body, unchanged. Never a
        translated legal document -- `children` (the legal prose itself) is
        never touched here, in any locale, by design.
      */}
      {locale !== 'en-ZA' && (
        <div className="mb-8 rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-300 print:hidden">
          {t('translationNotice')}
        </div>
      )}

      <div className="prose-legal text-sm text-[#1A0A0A] dark:text-[#F5F0ED] leading-relaxed max-w-[65ch] space-y-6">
        {children}
      </div>

      <div className="mt-14 pt-6 border-t border-[#F2EDE8] dark:border-[#2A1A1A] print:hidden">
        <Link href="/contact" className="text-sm font-semibold text-[#8B1A1A] hover:text-[#C4511F] transition-colors">
          {t('contactCta')} →
        </Link>
      </div>
    </div>
  )
}

/** Consistent h2 styling for legal page sections -- keeps heading hierarchy identical across all 12 pages. */
export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-extrabold uppercase tracking-wide text-[#1A0A0A] dark:text-[#F5F0ED] mb-2 mt-8 first:mt-0">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  )
}
