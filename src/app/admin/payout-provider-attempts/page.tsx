'use client'

import { useState, useEffect, useCallback } from 'react'
import { AdminPageHeader, StatCard, Pill, formatDateTime, formatMoney, secondaryButtonClass } from '@/components/admin/ui'

interface Attempt {
  id: string
  merchant_payout_id: string | null
  affiliate_commission_id: string | null
  provider: string
  provider_payout_id: string
  provider_request_id: string | null
  attempt_number: number
  amount: number
  currency: string
  provider_status: 'pending' | 'processing' | 'successful' | 'failed' | 'cancelled' | 'reversed'
  result_code: string | null
  failure_category: string | null
  provider_last_updated_at: string | null
  submission_started_at: string
  submitted_at: string | null
  resolved_at: string | null
  created_at: string
  payout_destinations: { bank_code: string; account_last4: string; payout_banks: { display_name: string } | null } | null
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  processing: 'bg-amber-100 text-amber-700',
  successful: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-red-100 text-red-700',
  reversed: 'bg-purple-100 text-purple-700',
}

/** Non-terminal for longer than this is flagged "stuck" -- a display heuristic only, never a state the system itself stores. */
const STUCK_THRESHOLD_MINUTES = 60

function isStuck(attempt: Attempt): boolean {
  if (attempt.provider_status !== 'pending' && attempt.provider_status !== 'processing') return false
  const ageMs = Date.now() - new Date(attempt.submission_started_at).getTime()
  return ageMs > STUCK_THRESHOLD_MINUTES * 60 * 1000
}

/**
 * /admin/payout-provider-attempts -- Master Launch Phase, Workstream F
 * (§50-53): the operational visibility this codebase was missing.
 * Read-only -- reconciliation itself happens via the existing
 * POST /api/admin/payout-provider-attempts/[id]/reconcile action,
 * linked from each row; this page never accepts a client-supplied
 * final state.
 */
export default function AdminPayoutProviderAttemptsPage() {
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [reconcilingId, setReconcilingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = statusFilter !== 'all' ? `?status=${statusFilter}` : ''
      const res = await fetch(`/api/admin/payout-provider-attempts${qs}`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setAttempts(data.attempts ?? [])
    } catch {
      setError('Could not load provider attempts.')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  async function reconcile(id: string) {
    setReconcilingId(id)
    try {
      const res = await fetch(`/api/admin/payout-provider-attempts/${id}/reconcile`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? 'Reconciliation failed.')
      }
      await load()
    } finally {
      setReconcilingId(null)
    }
  }

  const stuckCount = attempts.filter(isStuck).length
  const processingCount = attempts.filter((a) => a.provider_status === 'pending' || a.provider_status === 'processing').length
  const failedCount = attempts.filter((a) => a.provider_status === 'failed' || a.provider_status === 'cancelled').length
  const reversedCount = attempts.filter((a) => a.provider_status === 'reversed').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Payments Operations" title="Peach Provider Attempts" badge={stuckCount > 0 ? `${stuckCount} stuck` : undefined} />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Non-terminal" value={processingCount} />
        <StatCard label="Stuck (>1h)" value={stuckCount} />
        <StatCard label="Failed / Cancelled" value={failedCount} />
        <StatCard label="Reversed" value={reversedCount} />
      </div>

      <div className="flex gap-2">
        {['all', 'pending', 'processing', 'successful', 'failed', 'cancelled', 'reversed'].map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)} className={statusFilter === s ? 'px-3 py-1.5 rounded-lg text-xs font-medium bg-[#8B1A1A] text-white' : secondaryButtonClass}>
            {s}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-[#9B8B85]">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!loading && (
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
                <th className="px-4 py-3">Domain</th>
                <th className="px-4 py-3">Destination</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Attempt</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-b-0">
                  <td className="px-4 py-3 text-xs">
                    {a.merchant_payout_id ? 'Merchant' : 'Affiliate'}
                    <div className="text-[#9B8B85]">{(a.merchant_payout_id ?? a.affiliate_commission_id)?.slice(0, 8)}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {a.payout_destinations ? `${a.payout_destinations.payout_banks?.display_name ?? a.payout_destinations.bank_code} •••• ${a.payout_destinations.account_last4}` : '—'}
                  </td>
                  <td className="px-4 py-3">{formatMoney(a.amount, a.currency)}</td>
                  <td className="px-4 py-3">
                    <Pill value={a.provider_status} styles={STATUS_STYLES} />
                    {isStuck(a) && <span className="ml-2 text-[11px] text-amber-600 font-medium">STUCK</span>}
                  </td>
                  <td className="px-4 py-3 text-xs">#{a.attempt_number}</td>
                  <td className="px-4 py-3 text-xs">{formatDateTime(a.submission_started_at)}</td>
                  <td className="px-4 py-3">
                    {(a.provider_status === 'pending' || a.provider_status === 'processing') && (
                      <button onClick={() => reconcile(a.id)} disabled={reconcilingId === a.id} className={secondaryButtonClass}>
                        {reconcilingId === a.id ? 'Checking…' : 'Reconcile'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {attempts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-[#9B8B85]">
                    No provider attempts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
