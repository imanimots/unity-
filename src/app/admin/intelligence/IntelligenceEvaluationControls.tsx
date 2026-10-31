'use client'

import { useState } from 'react'

/**
 * E3: per-insight HUMAN EVALUATION control -- an admin's own opinion of
 * THIS Intelligence finding ("Rate this Intelligence finding"), never a
 * decision about the underlying user/merchant/transaction/dispute. No
 * automatic submission anywhere in this component: every write is the
 * direct result of an explicit click, and `incorrect`/`not_useful`
 * additionally require a native confirm() before the request is sent
 * (E3 Section 18) -- a lightweight guard against an accidental click,
 * not a moderation workflow.
 *
 * This component is UI-only and talks to exactly one endpoint, POST
 * /api/admin/intelligence/evaluations, which independently re-validates
 * everything server-side (admin auth, fingerprint/ruleId shape, AND
 * that the pair matches a currently-generated insight) -- this
 * component's job is presentation and the explicit-click gate, not
 * security.
 */

const EVALUATION_OPTIONS: Array<{ value: string; label: string; confirm?: string }> = [
  { value: 'useful', label: 'Useful' },
  { value: 'needs_investigation', label: 'Needs investigation' },
  { value: 'needs_more_data', label: 'Needs more data' },
  { value: 'not_useful', label: 'Not useful', confirm: 'Mark this Intelligence finding as Not useful?' },
  { value: 'incorrect', label: 'Incorrect', confirm: 'Mark this Intelligence finding as Incorrect?' },
]

export function IntelligenceEvaluationControls({
  fingerprint,
  fingerprintVersion,
  ruleId,
  initialEvaluation,
}: {
  fingerprint: string
  fingerprintVersion: number
  ruleId: string
  initialEvaluation: string | null
}) {
  const [current, setCurrent] = useState<string | null>(initialEvaluation)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(value: string) {
    const option = EVALUATION_OPTIONS.find((o) => o.value === value)
    if (option?.confirm && !window.confirm(option.confirm)) return

    setPending(value)
    setError(null)
    try {
      const res = await fetch('/api/admin/intelligence/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint, fingerprintVersion, ruleId, evaluation: value }),
      })
      if (!res.ok) {
        setError('Could not save this evaluation. Please try again.')
        return
      }
      setCurrent(value)
    } catch {
      // Evaluation is secondary to Intelligence consumption (E3 Section
      // 31) -- a network failure here never affects the insight card
      // itself, only this small control.
      setError('Could not save this evaluation. Please try again.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="pt-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-[#9B8B85]">Human evaluation -- rate this Intelligence finding</p>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {EVALUATION_OPTIONS.map((option) => {
          const isCurrent = current === option.value
          return (
            <button
              key={option.value}
              type="button"
              disabled={pending !== null}
              onClick={() => submit(option.value)}
              aria-pressed={isCurrent}
              className={`px-2 py-1 rounded-full text-[11px] font-medium border transition-colors disabled:opacity-50 ${
                isCurrent
                  ? 'bg-[#8B1A1A] text-white border-[#8B1A1A]'
                  : 'bg-white dark:bg-[#1A1010] text-[#6B5B55] dark:text-[#9B8B85] border-[#F2EDE8] dark:border-[#2A1A1A] hover:border-[#8B1A1A]'
              }`}
            >
              {isCurrent ? `✓ ${option.label}` : option.label}
              {pending === option.value ? '…' : ''}
            </button>
          )
        })}
      </div>
      {error && <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">{error}</p>}
    </div>
  )
}
