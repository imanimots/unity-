'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { AdminPageHeader, formatDateTime, secondaryButtonClass, newIdempotencyKey } from '@/components/admin/ui'

const REASON_LABEL: Record<string, string> = {
  prohibited_item: 'Prohibited item',
  misleading_listing: 'Misleading listing',
  scam_fraud: 'Scam / fraud',
  counterfeit: 'Counterfeit',
  inappropriate_content: 'Inappropriate content',
  other: 'Other',
}

interface ReportRow {
  id: string
  reporter_id: string
  listing_id: string
  reason: string
  description: string | null
  status: 'open' | 'reviewed' | 'dismissed'
  created_at: string
  listing: { id: string; title: string; status: string } | null
}

/**
 * Report Listing moderation queue (customer-journey P1 completion,
 * batch 8). Deliberately minimal: inspects reported listings and lets
 * an admin dismiss/mark a report reviewed. Taking action on the
 * listing itself (suspend etc.) happens on the existing
 * admin/listings/[id] page -- this queue only surfaces the signal, it
 * never suspends or hides a listing on its own.
 */
export default function AdminListingReportsPage() {
  const [reports, setReports] = useState<ReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/listing-reports')
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load reports')
      }
      const body = await res.json()
      setReports(body.reports ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load reports')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  async function act(path: string, body: Record<string, unknown>, key: string) {
    setBusyId(key)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, idempotency_key: newIdempotencyKey() }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Action failed')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  const reasonFor = (key: string) => reasonDraft[key] ?? ''

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Trust & Safety" title="Listing Reports" badge={`${reports.filter((r) => r.status === 'open').length} open`} />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-sm text-[#9B8B85]">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="text-sm text-[#9B8B85]">No reports.</p>
      ) : (
        <div className="space-y-4">
          {reports.map((r) => {
            const key = r.id
            return (
              <div key={r.id} className="rounded-xl border border-[#F2EDE8] bg-white p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-[#1A0A0A]">
                    {REASON_LABEL[r.reason] ?? r.reason} {r.status !== 'open' && <span className="text-[#9B8B85]">({r.status})</span>}
                  </div>
                  <div className="text-xs text-[#9B8B85]">{formatDateTime(r.created_at)}</div>
                </div>
                {r.description && <p className="text-sm text-[#6B5B55]">{r.description}</p>}

                {r.listing && (
                  <div className="rounded-lg bg-[#FAF8F5] p-3 text-sm space-y-1">
                    <Link href={`/admin/listings/${r.listing.id}`} className="font-medium text-[#8B1A1A] underline">
                      {r.listing.title}
                    </Link>
                    <p className="text-xs text-[#9B8B85]">Listing status: {r.listing.status}</p>
                  </div>
                )}

                {r.status === 'open' && (
                  <div className="space-y-2 pt-2 border-t border-[#F2EDE8]">
                    <input
                      type="text"
                      placeholder="Resolution note (optional)"
                      value={reasonFor(key)}
                      onChange={(e) => setReasonDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                      className="w-full text-sm px-3 py-1.5 rounded-lg border border-[#F2EDE8] bg-white text-[#1A0A0A] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyId === key}
                        onClick={() => act(`/api/admin/listing-reports/${r.id}/close`, { status: 'dismissed', resolution_note: reasonFor(key) || 'dismissed' }, key)}
                        className={secondaryButtonClass}
                      >
                        Dismiss report
                      </button>
                      <button
                        type="button"
                        disabled={busyId === key}
                        onClick={() => act(`/api/admin/listing-reports/${r.id}/close`, { status: 'reviewed', resolution_note: reasonFor(key) || undefined }, key)}
                        className={secondaryButtonClass}
                      >
                        Mark reviewed
                      </button>
                      {r.listing && (
                        <Link href={`/admin/listings/${r.listing.id}`} className={secondaryButtonClass}>
                          Review listing
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
