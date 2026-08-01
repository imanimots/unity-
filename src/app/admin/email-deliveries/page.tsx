'use client'

import { useState, useEffect, useCallback } from 'react'
import { Download, RotateCw } from 'lucide-react'
import { Pill, StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDateTime } from '@/components/admin/ui'

interface AdminEmailDeliveryRow {
  id: string
  eventType: string
  templateId: string
  recipientEmail: string | null
  status: string
  attempts: number
  provider: string | null
  createdAt: string
  sentAt: string | null
  lastError: string | null
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  sent: 'bg-green-100 text-green-700',
  failed_retryable: 'bg-orange-100 text-orange-700',
  failed_terminal: 'bg-red-100 text-red-700',
}

export default function AdminEmailDeliveriesPage() {
  const [rows, setRows] = useState<AdminEmailDeliveryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryMessage, setRetryMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      const res = await fetch(`/api/admin/email-deliveries?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load email deliveries')
      }
      const body = await res.json()
      setRows(body.deliveries ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load email deliveries')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  async function retry(id: string) {
    setRetryingId(id)
    setRetryMessage(null)
    try {
      const res = await fetch(`/api/admin/email-deliveries/${id}/retry`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Retry failed')
      setRetryMessage(`Retry result: ${body.status}`)
      await load()
    } catch (err) {
      setRetryMessage(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setRetryingId(null)
    }
  }

  const retryableCount = rows.filter((r) => r.status === 'failed_retryable').length
  const terminalCount = rows.filter((r) => r.status === 'failed_terminal').length
  const sentCount = rows.filter((r) => r.status === 'sent').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Notifications" title="Email Deliveries" />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={rows.length} />
        <StatCard label="Sent" value={sentCount} />
        <StatCard label="Retryable failures" value={retryableCount} />
        <StatCard label="Terminal failures" value={terminalCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="sent">Sent</option>
          <option value="failed_retryable">Failed (retryable)</option>
          <option value="failed_terminal">Failed (terminal)</option>
        </select>
        <a href={`/api/admin/email-deliveries?format=csv${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}`} className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
        {retryMessage ? <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">{retryMessage}</p> : null}
        <a href="/admin/email-previews" className={secondaryButtonClass}>Template previews</a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Event', 'Template', 'Recipient', 'Status', 'Attempts', 'Provider', 'Created', 'Sent', ''].map((h) => (
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
              ) : rows.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No email deliveries match your filters.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-nowrap">{r.eventType}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{r.templateId}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{r.recipientEmail ?? '—'}</td>
                    <td className="px-4 py-3"><Pill value={r.status} styles={STATUS_STYLES} /></td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{r.attempts}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85]">{r.provider ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDateTime(r.sentAt)}</td>
                    <td className="px-4 py-3">
                      {r.status === 'failed_retryable' ? (
                        <button disabled={retryingId === r.id} onClick={() => retry(r.id)} className={secondaryButtonClass}>
                          <RotateCw size={11} /> Retry
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
