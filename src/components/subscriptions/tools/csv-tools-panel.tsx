'use client'

import { useState, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { LISTING_CSV_COLUMNS } from '@/lib/subscriptions/csv'

interface ImportResultRow {
  rowIndex: number
  ok: boolean
  error?: string
  listingId?: string
}

/** Section 5-7: CSV export (own data, formula-safe) + import (drafts only, per-row report). */
export function CsvToolsPanel() {
  const t = useTranslations('merchant.tools.csv')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importResult, setImportResult] = useState<{ importedCount: number; failedCount: number; results: ImportResultRow[] } | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleImport(file: File) {
    setImporting(true)
    setError(null)
    setImportResult(null)
    try {
      const csv = await file.text()
      const res = await fetch('/api/listings/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) })
      const result = await res.json()
      if (!res.ok) {
        setError(result.error ?? t('genericError'))
        return
      }
      setImportResult(result)
    } catch {
      setError(t('genericError'))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] mb-3">{t('exportTitle')}</p>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-4">{t('exportDescription')}</p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- this downloads a CSV file, it is not a page navigation */}
        <a href="/api/listings/export" className="inline-block px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors">
          {t('exportAction')}
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] mb-3">{t('importTitle')}</p>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-2">{t('importDescription')}</p>
        <p className="text-xs text-[#9B8B85] mb-4">{t('importColumns', { columns: LISTING_CSV_COLUMNS.filter((c) => c !== 'id' && c !== 'status').join(', ') })}</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleImport(file)
          }}
          className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]"
          disabled={importing}
        />
        {importing && <p className="text-xs text-[#9B8B85] mt-2">{t('importing')}</p>}
        {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
        {importResult && (
          <div className="mt-4">
            <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">{t('importSummary', { imported: importResult.importedCount, failed: importResult.failedCount })}</p>
            {importResult.results
              .filter((r) => !r.ok)
              .map((r) => (
                <p key={r.rowIndex} className="text-xs text-red-600 dark:text-red-400">
                  {t('rowError', { row: r.rowIndex, error: r.error ?? '' })}
                </p>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
