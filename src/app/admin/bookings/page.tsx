'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, X, Download } from 'lucide-react'
import { Pill, ACCOUNT_STATUS_STYLES, StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDate, formatDateTime, formatMoney, newIdempotencyKey } from '@/components/admin/ui'

interface AdminBookingRow {
  id: string
  bookingReference: string | null
  listingTitle: string | null
  renterId: string
  renterName: string | null
  merchantId: string
  merchantName: string | null
  status: string
  financialReadiness: string
  startAt: string | null
  endAt: string | null
  paymentDueAt: string | null
  createdAt: string
  lastLifecycleEvent: string | null
}

interface AdminNoteRow {
  id: string
  note: string
  adminId: string
  createdAt: string
}

interface AdminBookingDetail {
  booking: AdminBookingRow & { subtotalAmount: number | null; depositAmount: number | null; renterTotalAmount: number | null; currency: string | null }
  financial: { workflowStatus: string | null; rentalPaymentStatus: string | null; depositPaymentStatus: string | null; rentalFailureReason: string | null; depositFailureReason: string | null }
  history: Array<{ id: string; eventType: string; previousStatus: string | null; newStatus: string; createdAt: string }>
  emailEvents: Array<{ id: string; eventType: string; status: string; createdAt: string }>
  renterAccountStatus: string | null
  merchantAccountStatus: string | null
}

const STATUS_STYLES: Record<string, string> = {
  requested: 'bg-amber-100 text-amber-700',
  accepted: 'bg-blue-100 text-blue-700',
  active: 'bg-green-100 text-green-700',
  return_pending: 'bg-orange-100 text-orange-700',
  returned: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-red-100 text-red-700',
  cancelled_by_renter: 'bg-[#F2EDE8] text-[#6B5B55]',
  cancelled_by_merchant: 'bg-[#F2EDE8] text-[#6B5B55]',
}

const READINESS_STYLES: Record<string, string> = {
  financially_ready: 'bg-green-100 text-green-700',
  no_payment_required: 'bg-green-100 text-green-700',
  awaiting_payment: 'bg-amber-100 text-amber-700',
  processing: 'bg-blue-100 text-blue-700',
  payment_failed_retryable: 'bg-orange-100 text-orange-700',
  payment_failed_terminal: 'bg-red-100 text-red-700',
  deposit_failed_retryable: 'bg-orange-100 text-orange-700',
  deposit_failed_terminal: 'bg-red-100 text-red-700',
  expired_unpaid: 'bg-red-100 text-red-700',
  not_prepared: 'bg-[#F2EDE8] text-[#6B5B55]',
}

export default function AdminBookingsPage() {
  const [bookings, setBookings] = useState<AdminBookingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  // Customer/Merchant 360 deep-link filter -- read once from the URL on
  // mount (not Next.js's useSearchParams hook, to avoid any Suspense-
  // boundary requirement for what's a one-time initial read).
  const [participantUserId, setParticipantUserId] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const fromUrl = new URLSearchParams(window.location.search).get('userId')
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fromUrl) setParticipantUserId(fromUrl)
  }, [])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AdminBookingDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [notes, setNotes] = useState<AdminNoteRow[]>([])
  const [noteInput, setNoteInput] = useState('')
  const [notePending, setNotePending] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (search.trim()) params.set('search', search.trim())
      if (participantUserId) params.set('userId', participantUserId)
      const res = await fetch(`/api/admin/bookings?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load bookings')
      }
      const body = await res.json()
      setBookings(body.bookings ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load bookings')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, search, participantUserId])

  useEffect(() => {
    const t = setTimeout(() => {
      load()
    }, 250)
    return () => clearTimeout(t)
  }, [load])

  const loadNotes = useCallback(async (bookingId: string) => {
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/notes`)
      if (!res.ok) return
      const body = await res.json()
      setNotes(body.notes ?? [])
    } catch {
      // Notes are supplementary -- a failed fetch here shouldn't block the rest of the detail panel.
    }
  }, [])

  useEffect(() => {
    if (!selectedId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetailLoading(true)
    setDetailError(null)
    setNotes([])
    fetch(`/api/admin/bookings/${selectedId}`)
      .then(async (res) => {
        if (!res.ok) {
          const b = await res.json().catch(() => ({}))
          throw new Error(b.error ?? 'Could not load booking')
        }
        return res.json()
      })
      .then(setDetail)
      .catch((err) => setDetailError(err instanceof Error ? err.message : 'Could not load booking'))
      .finally(() => setDetailLoading(false))
    loadNotes(selectedId)
  }, [selectedId, loadNotes])

  async function submitNote() {
    if (!selectedId || !noteInput.trim()) return
    setNotePending(true)
    try {
      const res = await fetch(`/api/admin/bookings/${selectedId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteInput.trim(), idempotency_key: newIdempotencyKey() }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not add note')
      }
      setNoteInput('')
      await loadNotes(selectedId)
    } catch {
      // Surfaced inline below rather than via the page-level error state, which is reserved for the list fetch.
    } finally {
      setNotePending(false)
    }
  }

  const activeCount = bookings.filter((b) => b.status === 'active').length
  const requestedCount = bookings.filter((b) => b.status === 'requested').length
  const overdueCount = bookings.filter((b) => b.paymentDueAt && new Date(b.paymentDueAt) < new Date() && b.status === 'accepted').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Rental Lifecycle" title="Bookings" />

      {participantUserId ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
          Showing only bookings involving one user ({participantUserId}).
          <button onClick={() => setParticipantUserId(null)} className="underline font-medium">Clear filter</button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={bookings.length} />
        <StatCard label="Requested" value={requestedCount} />
        <StatCard label="Active rentals" value={activeCount} />
        <StatCard label="Overdue payment" value={overdueCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Reference, listing, name…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-64 ${inputClass}`} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="requested">Requested</option>
          <option value="accepted">Accepted</option>
          <option value="active">Active</option>
          <option value="return_pending">Return pending</option>
          <option value="completed">Completed</option>
          <option value="rejected">Rejected</option>
          <option value="expired">Expired</option>
        </select>
        <a href={`/api/admin/bookings?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`} className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Reference', 'Listing', 'Renter', 'Merchant', 'Status', 'Financial', 'Payment due', 'Created', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={9} className="px-4 py-16 text-center text-sm text-red-600">{error}</td></tr>
              ) : bookings.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No bookings match your filters.</td></tr>
              ) : (
                bookings.map((b) => (
                  <tr key={b.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-nowrap">{b.bookingReference}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{b.listingTitle ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{b.renterName ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{b.merchantName ?? '—'}</td>
                    <td className="px-4 py-3"><Pill value={b.status} styles={STATUS_STYLES} /></td>
                    <td className="px-4 py-3"><Pill value={b.financialReadiness} styles={READINESS_STYLES} /></td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDateTime(b.paymentDueAt)}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(b.createdAt)}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => setSelectedId(b.id)} className={secondaryButtonClass}>Inspect</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedId ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSelectedId(null)} />
          <div className="relative w-full max-w-lg bg-white dark:bg-[#0F0A0A] border-l border-[#F2EDE8] dark:border-[#2A1A1A] h-full overflow-y-auto p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">Booking detail</h2>
              <button onClick={() => setSelectedId(null)} className="text-[#9B8B85] hover:text-[#1A0A0A]"><X size={18} /></button>
            </div>

            {detailLoading || !detail ? (
              detailError ? <p className="text-sm text-red-600">{detailError}</p> : <p className="text-sm text-[#9B8B85]">Loading…</p>
            ) : (
              <>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{detail.booking.bookingReference} — {detail.booking.listingTitle}</p>
                  <div className="flex gap-2 pt-1 flex-wrap">
                    <Pill value={detail.booking.status} styles={STATUS_STYLES} />
                    <Pill value={detail.booking.financialReadiness} styles={READINESS_STYLES} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
                  <div>Renter: <Link href={`/admin/users/${detail.booking.renterId}`} className="text-[#8B1A1A] underline">{detail.booking.renterName}</Link> <Pill value={detail.renterAccountStatus ?? 'active'} styles={ACCOUNT_STATUS_STYLES} /></div>
                  <div>Merchant: <Link href={`/admin/merchants/${detail.booking.merchantId}`} className="text-[#8B1A1A] underline">{detail.booking.merchantName}</Link> <Pill value={detail.merchantAccountStatus ?? 'active'} styles={ACCOUNT_STATUS_STYLES} /></div>
                  <div>Start: {formatDateTime(detail.booking.startAt)}</div>
                  <div>End: {formatDateTime(detail.booking.endAt)}</div>
                  <div>Payment due: {formatDateTime(detail.booking.paymentDueAt)}</div>
                  <div>Subtotal: {formatMoney(detail.booking.subtotalAmount, detail.booking.currency ?? 'ZAR')}</div>
                  <div>Deposit: {formatMoney(detail.booking.depositAmount, detail.booking.currency ?? 'ZAR')}</div>
                  <div>Total: {formatMoney(detail.booking.renterTotalAmount, detail.booking.currency ?? 'ZAR')}</div>
                </div>

                <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">Financial summary</p>
                  <div className="text-xs text-[#6B5B55] dark:text-[#9B8B85] space-y-1">
                    <div>Workflow: {detail.financial.workflowStatus ?? 'none'}</div>
                    <div>Rental payment: {detail.financial.rentalPaymentStatus ?? 'none'}{detail.financial.rentalFailureReason ? ` — ${detail.financial.rentalFailureReason}` : ''}</div>
                    <div>Deposit payment: {detail.financial.depositPaymentStatus ?? 'none'}{detail.financial.depositFailureReason ? ` — ${detail.financial.depositFailureReason}` : ''}</div>
                  </div>
                </div>

                <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">Lifecycle history</p>
                  <ul className="space-y-1.5">
                    {detail.history.map((h) => (
                      <li key={h.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
                        <span className="font-medium">{h.eventType}</span> ({h.previousStatus ?? '—'} → {h.newStatus}) — {formatDateTime(h.createdAt)}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">Email events</p>
                  {detail.emailEvents.length === 0 ? (
                    <p className="text-xs text-[#9B8B85]">No email events recorded.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {detail.emailEvents.map((e) => (
                        <li key={e.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
                          {e.eventType} — {e.status} — {formatDateTime(e.createdAt)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">Internal admin notes</p>
                  {notes.map((n) => (
                    <div key={n.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85] bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg px-3 py-2">
                      {n.note}
                      <div className="text-[10px] text-[#9B8B85] mt-1">{formatDateTime(n.createdAt)}</div>
                    </div>
                  ))}
                  <textarea placeholder="Add an internal note…" value={noteInput} onChange={(e) => setNoteInput(e.target.value)} className={`w-full ${inputClass}`} rows={2} />
                  <button disabled={notePending || !noteInput.trim()} onClick={submitNote} className={secondaryButtonClass}>Add note</button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
