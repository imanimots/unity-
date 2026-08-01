'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Loader2, Clock3, Info } from 'lucide-react'
import { PaymentBreakdown } from '@/components/payments/payment-breakdown'
import { FinancialReadinessCard } from '@/components/payments/financial-readiness-card'
import { TestPaymentScenarioSelector } from '@/components/payments/test-payment-scenario-selector'
import { PaymentAttemptSummary } from '@/components/payments/payment-attempt-summary'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import type { CheckoutTestScenario } from '@/lib/checkout/test-scenario'
import type { FinancialReadinessState, PaymentStatus } from '@/lib/checkout/financial-readiness'
import type { CheckoutAllowedAction } from '@/lib/checkout/eligibility'

interface InitialSummary {
  bookingReference: string | null
  listingTitle: string
  merchantDisplayName: string
  startAt: string | null
  endAt: string | null
  paymentDueAt: string | null
  durationUnits: number | null
  rateUnit: string | null
  rateAmount: number | null
  subtotalAmount: number | null
  platformFeeAmount: number | null
  depositAmount: number | null
  totalAmount: number | null
  currency: string
}

interface FinancialStatusResponse {
  eligibility: { eligible: boolean; reasons: string[]; allowedActions: CheckoutAllowedAction[] }
  readiness: FinancialReadinessState
  rentalPaymentStatus: PaymentStatus
  depositPaymentStatus: PaymentStatus
  rentalFailureReason: string | null
  depositFailureReason: string | null
  testModeAvailable: boolean
}

/** Purely cosmetic client-side countdown -- server time remains authoritative; every submit/refresh re-checks deadline validity server-side regardless of what this displays. */
function DeadlineCountdown({ paymentDueAt }: { paymentDueAt: string | null }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!paymentDueAt) return null
  const remainingMs = new Date(paymentDueAt).getTime() - now

  if (remainingMs <= 0) {
    return (
      <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1.5">
        <Clock3 size={12} /> Payment deadline has passed
      </p>
    )
  }

  const totalSeconds = Math.floor(remainingMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const label = hours > 0 ? `${hours}h ${minutes}m remaining` : minutes > 0 ? `${minutes}m ${seconds}s remaining` : `${seconds}s remaining`

  return (
    <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
      <Clock3 size={12} /> Time to pay: {label}
    </p>
  )
}

export function CheckoutFlow({ bookingId, initial }: { bookingId: string; initial: InitialSummary }) {
  const [status, setStatus] = useState<FinancialStatusResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scenario, setScenario] = useState<CheckoutTestScenario>('success')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [lateSuccessNotice, setLateSuccessNotice] = useState<string | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [agreedToPaymentTerms, setAgreedToPaymentTerms] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/bookings/${bookingId}/financial-status`)
      const data = await res.json()
      if (!res.ok) {
        setLoadError(data.error ?? 'Could not load payment status')
        return
      }
      setStatus(data)
      setLoadError(null)
    } catch {
      setLoadError('Network error — please refresh')
    }
  }, [bookingId])

  useEffect(() => {
    // Initial load -- setState runs inside refresh()'s first branch, same
    // class of finding as the existing accepted baseline in
    // src/hooks/use-auth.ts / src/app/admin/listings/page.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
  }, [refresh])

  async function submit() {
    setSubmitting(true)
    setSubmitError(null)
    setLateSuccessNotice(null)
    try {
      const body: Record<string, string> = { idempotency_key: idempotencyKey }
      if (status?.testModeAvailable) body.test_scenario = scenario
      const res = await fetch(`/api/bookings/${bookingId}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok && res.status !== 200) {
        setSubmitError(data.error ?? 'Checkout could not be completed')
      } else {
        if (data.status === 'late_success_after_expiry') {
          setLateSuccessNotice(data.error ?? 'Your payment was processed, but this booking had already expired.')
        }
        try {
          await fetch('/api/legal/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ policies: ['payments-and-deposits', 'refunds'], context: 'checkout' }),
          })
        } catch {
          // best-effort -- the checkout attempt already completed
        }
      }
      // A new logical attempt always needs a new idempotency key -- reused
      // only for an exact-replay retry of the identical outcome, so
      // generating a fresh one here is what makes the *next* click a
      // genuinely new attempt rather than a replay of a terminal result.
      setIdempotencyKey(crypto.randomUUID())
      await refresh()
    } catch {
      setSubmitError('Network error — please try again')
    } finally {
      setSubmitting(false)
    }
  }

  if (loadError) {
    return <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-sm text-[#9B8B85]">
        <Loader2 size={16} className="animate-spin" /> Loading payment details…
      </div>
    )
  }

  const depositRequired = (initial.depositAmount ?? 0) > 0
  const canAct = status.eligibility.allowedActions.includes('initiate') || status.eligibility.allowedActions.includes('retry')
  const actionLabel = status.eligibility.allowedActions.includes('retry') ? 'Retry payment' : 'Pay now'

  return (
    <div className="space-y-4">
      <TestModeBanner />

      <PaymentBreakdown
        bookingReference={initial.bookingReference}
        listingTitle={initial.listingTitle}
        merchantDisplayName={initial.merchantDisplayName}
        startAt={initial.startAt}
        endAt={initial.endAt}
        durationUnits={initial.durationUnits}
        rateUnit={initial.rateUnit}
        rateAmount={initial.rateAmount}
        subtotalAmount={initial.subtotalAmount}
        platformFeeAmount={initial.platformFeeAmount}
        depositAmount={initial.depositAmount}
        totalAmount={initial.totalAmount}
        currency={initial.currency}
        rentalPaymentStatus={status.rentalPaymentStatus}
        depositPaymentStatus={status.depositPaymentStatus}
      />

      <FinancialReadinessCard readiness={status.readiness} audience="renter" />

      {status.readiness !== 'financially_ready' && status.readiness !== 'no_payment_required' && status.readiness !== 'expired_unpaid' && (
        <DeadlineCountdown paymentDueAt={initial.paymentDueAt} />
      )}

      {lateSuccessNotice && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-xl p-4 flex items-start gap-2.5">
          <Info size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800 dark:text-amber-300">{lateSuccessNotice}</p>
        </div>
      )}

      {(status.rentalPaymentStatus === 'failed' || status.depositPaymentStatus === 'failed') && (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
          <PaymentAttemptSummary
            rentalPaymentStatus={status.rentalPaymentStatus}
            rentalFailureReason={status.rentalFailureReason}
            depositRequired={depositRequired}
            depositPaymentStatus={status.depositPaymentStatus}
            depositFailureReason={status.depositFailureReason}
          />
        </div>
      )}

      {!status.eligibility.eligible && !canAct && (
        <p className="text-xs text-[#9B8B85]">{status.eligibility.reasons.join(' ')}</p>
      )}

      {canAct && status.testModeAvailable && <TestPaymentScenarioSelector value={scenario} onChange={setScenario} disabled={submitting} />}

      {canAct && (
        <label className="flex items-start gap-2.5 text-xs text-[#6B5B55] dark:text-[#9B8B85] cursor-pointer">
          <input
            type="checkbox"
            checked={agreedToPaymentTerms}
            onChange={(e) => setAgreedToPaymentTerms(e.target.checked)}
            className="mt-0.5 rounded border-[#E8E0D8] accent-[#8B1A1A] shrink-0"
          />
          <span>
            I agree to the{' '}
            <Link href="/payments-and-deposits" className="text-[#8B1A1A] underline hover:no-underline">Payment and Deposit Policy</Link> and{' '}
            <Link href="/refunds" className="text-[#8B1A1A] underline hover:no-underline">Refund Policy</Link>, and understand this is test mode — no real money will be charged.
          </span>
        </label>
      )}

      {canAct && (
        <button
          onClick={submit}
          disabled={submitting || !agreedToPaymentTerms}
          className="w-full py-3 rounded-lg bg-[#8B1A1A] hover:bg-[#7A1616] text-white text-sm font-semibold uppercase tracking-[0.08em] transition-colors disabled:opacity-50"
        >
          {submitting ? 'Processing…' : actionLabel}
        </button>
      )}

      {submitError && <p className="text-xs text-red-600 dark:text-red-400">{submitError}</p>}

      {status.readiness === 'financially_ready' && (
        <Link
          href="/dashboard/renter/bookings"
          className="block text-center w-full py-3 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm font-semibold uppercase tracking-[0.08em] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]"
        >
          Back to bookings
        </Link>
      )}
    </div>
  )
}
