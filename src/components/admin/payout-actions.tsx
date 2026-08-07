'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Play, RotateCcw, Banknote, XCircle } from 'lucide-react'
import type { PayoutStatus } from '@/lib/payouts/status-labels'
import { PAYOUT_METHODS, PAYOUT_FAILURE_CATEGORIES, PAYOUT_FAILURE_CATEGORY_LABELS } from '@/lib/payouts/status-labels'

interface Props {
  payoutId: string
  status: PayoutStatus
}

type ActionKind = 'mark-processing' | 'mark-paid' | 'mark-failed' | 'retry'

const ACTION_META: Record<ActionKind, { label: string; icon: typeof Play }> = {
  'mark-processing': { label: 'Start processing', icon: Play },
  'mark-paid': { label: 'Record manual payout', icon: Banknote },
  'mark-failed': { label: 'Mark failed', icon: XCircle },
  retry: { label: 'Retry', icon: RotateCcw },
}

/**
 * Only shows transitions valid for the current status. mark-processing
 * and retry both re-validate full eligibility server-side inside the
 * RPC -- this component never assumes the action will succeed. No
 * payout provider is ever called by any of these actions.
 */
function availableActions(status: PayoutStatus): ActionKind[] {
  if (status === 'pending') return ['mark-processing']
  if (status === 'processing') return ['mark-paid', 'mark-failed']
  if (status === 'failed') return ['retry']
  return []
}

export function PayoutActions({ payoutId, status }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState<ActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const actions = availableActions(status)

  async function run(action: ActionKind) {
    setError(null)
    const body: Record<string, unknown> = { idempotency_key: crypto.randomUUID() }

    if (action === 'mark-processing') {
      const reason = window.prompt('Optional operational note for starting processing:') ?? undefined
      if (reason) body.reason = reason
    }

    if (action === 'retry') {
      const reason = window.prompt('Reason for retrying this payout (required):')
      if (!reason || !reason.trim()) return
      body.reason = reason
    }

    if (action === 'mark-failed') {
      const categoryPrompt = `Failure category (required) -- one of:\n${PAYOUT_FAILURE_CATEGORIES.map((c) => `${c} (${PAYOUT_FAILURE_CATEGORY_LABELS[c]})`).join('\n')}`
      const category = window.prompt(categoryPrompt)
      if (!category || !PAYOUT_FAILURE_CATEGORIES.includes(category as (typeof PAYOUT_FAILURE_CATEGORIES)[number])) {
        setError('A valid failure category is required')
        return
      }
      const reason = window.prompt('Admin reason (required, not shown to the merchant):')
      if (!reason || !reason.trim()) return
      body.failureCategory = category
      body.reason = reason
    }

    if (action === 'mark-paid') {
      const payoutReference = window.prompt('Payout reference (required, safe for merchant display):')
      if (!payoutReference || !payoutReference.trim()) return
      const methodPrompt = `Payout method (required) -- one of: ${PAYOUT_METHODS.join(', ')}`
      const payoutMethod = window.prompt(methodPrompt)
      if (!payoutMethod || !PAYOUT_METHODS.includes(payoutMethod as (typeof PAYOUT_METHODS)[number])) {
        setError('A valid payout method is required')
        return
      }
      const confirmed = window.confirm('Confirm: this authorised admin action records that an external payment was genuinely completed. No real banking details are collected. Continue?')
      if (!confirmed) return
      body.payoutReference = payoutReference
      body.payoutMethod = payoutMethod
      body.confirmManualPayment = true
    }

    setPending(action)
    try {
      const res = await fetch(`/api/admin/payouts/${payoutId}/${action}`, {
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
      {actions.length === 0 ? (
        <p className="text-xs text-[#9B8B85]">No actions available -- this payout is in a terminal or unrecognized state.</p>
      ) : (
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
      )}
      {status === 'processing' && (
        <p className="text-[11px] text-[#9B8B85] mt-2">No automated payout provider is connected. Starting processing only records that Unity has begun processing this payout manually.</p>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
    </div>
  )
}
