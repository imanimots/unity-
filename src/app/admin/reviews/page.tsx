'use client'

import { useState, useEffect, useCallback } from 'react'
import { AdminPageHeader, formatDateTime, secondaryButtonClass, newIdempotencyKey } from '@/components/admin/ui'

interface ReportRow {
  id: string
  reporter_id: string
  target_type: 'review' | 'reply'
  target_id: string
  reason: string
  description: string | null
  status: 'open' | 'reviewed' | 'dismissed'
  created_at: string
  review: {
    id: string
    rating: number
    comment: string | null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    header_snapshot: any
    reviewer_id: string
    reviewee_id: string
    text_hidden_at: string | null
    invalidated_at: string | null
    published_at: string | null
  } | null
  reply: { id: string; review_id: string; reply_text: string; hidden_at: string | null } | null
}

interface HistoryRow {
  id: string
  review_id: string
  action: string
  actor_admin_id: string
  reason: string
  created_at: string
}

/**
 * Reviews V2 admin moderation queue (Rule 29). Inspects reported
 * review/reply content, safe transaction provenance, and prior
 * moderation history; dismisses reports; hides/unhides review text;
 * invalidates an entire review; hides a reply. No path here can edit a
 * star rating, author fake reviews, or impersonate a reviewer, and no
 * history row is ever deleted (review_moderation_history is append-only).
 */
export default function AdminReviewsPage() {
  const [reports, setReports] = useState<ReportRow[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/reviews')
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load reports')
      }
      const body = await res.json()
      setReports(body.reports ?? [])
      setHistory(body.history ?? [])
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
      <AdminPageHeader eyebrow="Trust & Safety" title="Review Moderation" badge={`${reports.filter((r) => r.status === 'open').length} open`} />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-sm text-[#9B8B85]">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="text-sm text-[#9B8B85]">No reports.</p>
      ) : (
        <div className="space-y-4">
          {reports.map((r) => {
            const reviewHistory = history.filter((h) => h.review_id === r.review?.id)
            const key = r.id
            return (
              <div key={r.id} className="rounded-xl border border-[#F2EDE8] bg-white p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-[#1A0A0A]">
                    Report: {r.target_type} — {r.reason} {r.status !== 'open' && <span className="text-[#9B8B85]">({r.status})</span>}
                  </div>
                  <div className="text-xs text-[#9B8B85]">{formatDateTime(r.created_at)}</div>
                </div>
                {r.description && <p className="text-sm text-[#6B5B55]">{r.description}</p>}

                {r.review && (
                  <div className="rounded-lg bg-[#FAF8F5] p-3 text-sm space-y-1">
                    <p className="font-medium text-[#1A0A0A]">{r.review.header_snapshot?.title ?? 'Transaction'}</p>
                    <p className="text-[#1A0A0A]">Rating: {r.review.rating} / 5</p>
                    <p className="text-[#1A0A0A]">{r.review.text_hidden_at ? <span className="italic text-[#9B8B85]">Text hidden</span> : r.review.comment}</p>
                    <p className="text-xs text-[#9B8B85]">
                      invalidated: {r.review.invalidated_at ? 'yes' : 'no'} · published: {r.review.published_at ? 'yes' : 'no'}
                    </p>
                  </div>
                )}
                {r.reply && (
                  <div className="rounded-lg bg-[#FAF8F5] p-3 text-sm space-y-1">
                    <p className="font-medium text-[#1A0A0A]">Reply</p>
                    <p className="text-[#1A0A0A]">{r.reply.hidden_at ? <span className="italic text-[#9B8B85]">Reply hidden</span> : r.reply.reply_text}</p>
                  </div>
                )}

                {reviewHistory.length > 0 && (
                  <details className="text-xs text-[#9B8B85]">
                    <summary>Moderation history ({reviewHistory.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {reviewHistory.map((h) => (
                        <li key={h.id}>
                          {formatDateTime(h.created_at)} — {h.action}: {h.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {r.status === 'open' && (
                  <div className="space-y-2 pt-2 border-t border-[#F2EDE8]">
                    <input
                      type="text"
                      placeholder="Reason (required for any action)"
                      value={reasonFor(key)}
                      onChange={(e) => setReasonDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                      className="w-full text-sm px-3 py-1.5 rounded-lg border border-[#F2EDE8] bg-white text-[#1A0A0A] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyId === key}
                        onClick={() => act(`/api/admin/review-reports/${r.id}/close`, { status: 'dismissed', resolution_note: reasonFor(key) || 'dismissed' }, key)}
                        className={secondaryButtonClass}
                      >
                        Dismiss report
                      </button>
                      {r.target_type === 'review' && r.review && !r.review.text_hidden_at && (
                        <button
                          type="button"
                          disabled={busyId === key || !reasonFor(key)}
                          onClick={() => act(`/api/admin/reviews/${r.review!.id}/hide-text`, { reason: reasonFor(key) }, key)}
                          className={secondaryButtonClass}
                        >
                          Hide review text
                        </button>
                      )}
                      {r.target_type === 'review' && r.review && r.review.text_hidden_at && (
                        <button
                          type="button"
                          disabled={busyId === key || !reasonFor(key)}
                          onClick={() => act(`/api/admin/reviews/${r.review!.id}/unhide-text`, { reason: reasonFor(key) }, key)}
                          className={secondaryButtonClass}
                        >
                          Unhide review text
                        </button>
                      )}
                      {r.target_type === 'review' && r.review && !r.review.invalidated_at && (
                        <button
                          type="button"
                          disabled={busyId === key || !reasonFor(key)}
                          onClick={() => act(`/api/admin/reviews/${r.review!.id}/invalidate`, { reason: reasonFor(key) }, key)}
                          className={secondaryButtonClass}
                        >
                          Invalidate entire review
                        </button>
                      )}
                      {r.target_type === 'reply' && r.reply && !r.reply.hidden_at && (
                        <button
                          type="button"
                          disabled={busyId === key || !reasonFor(key)}
                          onClick={() => act(`/api/admin/review-replies/${r.reply!.id}/hide`, { reason: reasonFor(key) }, key)}
                          className={secondaryButtonClass}
                        >
                          Hide reply
                        </button>
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
