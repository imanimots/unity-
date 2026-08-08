'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'

const PLAN_IDS = ['starter', 'pro', 'elite'] as const

interface Props {
  merchantId: string
  currentPlanId: string
}

/**
 * The one admin mutation surface for subscriptions -- a narrow,
 * reason-required correction. Never charges the merchant, never
 * rewrites history; appends a new merchant_subscription_history row via
 * admin_correct_merchant_subscription().
 */
export function SubscriptionAdminActions({ merchantId, currentPlanId }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function correct() {
    setError(null)
    const planPrompt = `New plan id (required) -- one of: ${PLAN_IDS.join(', ')}`
    const newPlanId = window.prompt(planPrompt, currentPlanId)
    if (!newPlanId || !PLAN_IDS.includes(newPlanId as (typeof PLAN_IDS)[number])) {
      if (newPlanId !== null) setError('A valid plan id is required')
      return
    }
    const immediateAnswer = window.confirm('Apply immediately? OK = immediate, Cancel = schedule for the next billing period.')
    const reason = window.prompt('Reason for this correction (required, not shown to the merchant):')
    if (!reason || !reason.trim()) return

    setPending(true)
    try {
      const res = await fetch(`/api/admin/subscriptions/${merchantId}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPlanId, immediate: immediateAnswer, reason, idempotency_key: crypto.randomUUID() }),
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
      setPending(false)
    }
  }

  return (
    <div className="mt-2">
      <button
        onClick={correct}
        disabled={pending}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors disabled:opacity-50"
      >
        <ShieldCheck size={13} /> {pending ? 'Working…' : 'Correct plan'}
      </button>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
    </div>
  )
}
