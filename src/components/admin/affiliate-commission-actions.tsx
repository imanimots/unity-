'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pause, Play, Ban, RotateCcw, Banknote, Plus } from 'lucide-react'
import type { AffiliateCommissionStatus } from '@/lib/affiliate/status-labels'

interface Props {
  commissionId: string
  status: AffiliateCommissionStatus
}

type ActionKind = 'hold' | 'release' | 'void' | 'retry' | 'mark-paid' | 'adjust'

const ACTION_META: Record<ActionKind, { label: string; icon: typeof Pause; requiresReason: boolean; requiresAmount?: boolean }> = {
  hold: { label: 'Hold', icon: Pause, requiresReason: true },
  release: { label: 'Release hold', icon: Play, requiresReason: false },
  void: { label: 'Void', icon: Ban, requiresReason: true },
  retry: { label: 'Retry payout', icon: RotateCcw, requiresReason: true },
  'mark-paid': { label: 'Record manual payout', icon: Banknote, requiresReason: true },
  adjust: { label: 'Add adjustment', icon: Plus, requiresReason: true, requiresAmount: true },
}

/**
 * Every override requires a mandatory reason (Part G) and never touches
 * the original commission's amount/rate/affiliate/customer/merchant/
 * listing/payment reference -- corrections go through void+regenerate
 * or an append-only adjustment only.
 */
function availableActions(status: AffiliateCommissionStatus): ActionKind[] {
  const actions: ActionKind[] = []
  if (['pending', 'approved', 'payout_queued'].includes(status)) actions.push('hold')
  if (status === 'held') actions.push('release')
  if (['pending', 'held', 'approved', 'payout_queued', 'failed'].includes(status)) actions.push('void')
  if (status === 'failed') {
    actions.push('retry')
    actions.push('mark-paid')
  }
  if (['approved', 'payout_queued', 'processing'].includes(status)) actions.push('mark-paid')
  actions.push('adjust')
  return actions
}

export function AffiliateCommissionActions({ commissionId, status }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState<ActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const actions = availableActions(status)

  async function run(action: ActionKind) {
    const meta = ACTION_META[action]
    let reason: string | null = null
    let amount: number | null = null

    if (meta.requiresReason) {
      reason = window.prompt(`Reason for this action (required):`)
      if (!reason || !reason.trim()) return
    }
    if (meta.requiresAmount) {
      const raw = window.prompt('Adjustment amount (use a negative number for a deduction):')
      if (raw === null) return
      amount = Number(raw)
      if (!Number.isFinite(amount)) {
        setError('Adjustment amount must be a valid number')
        return
      }
    }

    setPending(action)
    setError(null)
    try {
      const body: Record<string, unknown> = { idempotency_key: crypto.randomUUID() }
      if (reason) body.reason = reason
      if (amount !== null) body.amount = amount

      const res = await fetch(`/api/admin/affiliate-commissions/${commissionId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Something went wrong')
        return
      }
      router.refresh()
    } catch {
      setError('Network error — please try again')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const meta = ACTION_META[action]
          const Icon = meta.icon
          return (
            <button
              key={action}
              onClick={() => run(action)}
              disabled={pending !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors disabled:opacity-50"
            >
              <Icon size={13} /> {pending === action ? 'Working…' : meta.label}
            </button>
          )
        })}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
    </div>
  )
}
