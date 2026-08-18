'use client'

import { useState } from 'react'
import { useRouter, Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Check, X, Play, PackageCheck, Ban, CreditCard, MessageCircle } from 'lucide-react'
import type { BookingLifecycleStatus } from '@/lib/bookings/status-labels'
import { OpenDisputeDialog } from '@/components/disputes/open-dispute-dialog'

/** A dispute only makes sense once the transaction has actually progressed past pure negotiation. */
const DISPUTABLE_STATUSES: BookingLifecycleStatus[] = ['active', 'return_pending', 'returned', 'completed']

interface Props {
  bookingId: string
  status: BookingLifecycleStatus
  role: 'renter' | 'merchant'
  /**
   * Step 6: whether this booking is currently financially ready to start
   * (derived server-side via getBookingFinancialEligibility -- see the
   * dashboard pages that render this component). Only meaningful at
   * status 'accepted'; ignored for every other status. Undefined is
   * treated as "not ready" -- a caller that hasn't computed readiness
   * must never accidentally show a start button that will just fail.
   */
  financiallyReady?: boolean
}

type ActionKind = 'accept' | 'reject' | 'cancel' | 'start' | 'return' | 'confirm-return' | 'checkout'

const ACTION_META: Record<ActionKind, { labelKey: string; icon: typeof Check; classes: string; promptReason?: boolean }> = {
  accept: { labelKey: 'accept', icon: Check, classes: 'bg-green-600 hover:bg-green-700 text-white' },
  reject: { labelKey: 'decline', icon: X, classes: 'border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]', promptReason: true },
  cancel: { labelKey: 'cancelBooking', icon: Ban, classes: 'border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]', promptReason: true },
  start: { labelKey: 'startRental', icon: Play, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  return: { labelKey: 'initiateReturn', icon: PackageCheck, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'confirm-return': { labelKey: 'confirmReturn', icon: Check, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  checkout: { labelKey: 'checkoutAndPay', icon: CreditCard, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
}

/**
 * Which actions are available for the caller's role at each status -- must
 * match the RPC transition rules in
 * supabase/migrations/20260730000007_booking_rpcs.sql exactly (the RPC is
 * the real enforcement point; this only decides which buttons to show).
 *
 * "checkout" is a navigation link (see render below), not an RPC action.
 * "start" is now gated on financiallyReady (Step 6) -- an accepted-but-
 * unpaid booking never shows a start button that the server would just
 * reject with 422 financial_requirements_incomplete; the real enforcement
 * still lives in the start-rental route (src/app/api/bookings/[id]/start),
 * this only decides what to render.
 */
function availableActions(status: BookingLifecycleStatus, role: 'renter' | 'merchant', financiallyReady: boolean): ActionKind[] {
  if (role === 'merchant') {
    if (status === 'requested') return ['accept', 'reject']
    if (status === 'accepted') return financiallyReady ? ['start', 'cancel'] : ['cancel']
    if (status === 'active') return ['return']
    if (status === 'return_pending') return ['confirm-return']
    return []
  }
  if (status === 'requested') return ['cancel']
  if (status === 'accepted') return financiallyReady ? ['checkout', 'start', 'cancel'] : ['checkout', 'cancel']
  if (status === 'active') return ['return']
  if (status === 'return_pending') return ['confirm-return']
  return []
}

export function BookingActions({ bookingId, status, role, financiallyReady = false }: Props) {
  const router = useRouter()
  const t = useTranslations('rent')
  const tErrors = useTranslations('errors')
  const [pending, setPending] = useState<ActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const actions = availableActions(status, role, financiallyReady)
  const showDispute = DISPUTABLE_STATUSES.includes(status)

  async function run(action: ActionKind) {
    const meta = ACTION_META[action]
    let reason: string | null = null
    if (meta.promptReason) {
      reason = window.prompt(action === 'reject' ? t('actions.declineReasonPrompt') : t('actions.cancelReasonPrompt'))
      if (reason === null) return // user hit cancel on the prompt itself
    }

    setPending(action)
    setError(null)
    try {
      const body: Record<string, string> = { idempotency_key: crypto.randomUUID() }
      if (action === 'reject' && reason) body.rejection_reason = reason
      if (action === 'cancel' && reason) body.cancellation_reason = reason

      const res = await fetch(`/api/bookings/${bookingId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? tErrors('generic'))
        return
      }
      router.refresh()
    } catch {
      setError(tErrors('network'))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const meta = ACTION_META[action]
          const Icon = meta.icon
          const label = t(`actions.${meta.labelKey}`)

          if (action === 'checkout') {
            return (
              <Link
                key={action}
                href={`/dashboard/renter/bookings/${bookingId}/checkout`}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors ${meta.classes}`}
              >
                <Icon size={13} /> {label}
              </Link>
            )
          }

          return (
            <button
              key={action}
              onClick={() => run(action)}
              disabled={pending !== null}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors disabled:opacity-50 ${meta.classes}`}
            >
              <Icon size={13} /> {pending === action ? t('actions.working') : label}
            </button>
          )
        })}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Link
          href={`/chat?booking=${bookingId}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] dark:text-[#9B8B85] hover:underline"
        >
          <MessageCircle size={13} /> {t('actions.message')}
        </Link>
        {showDispute && (
          <OpenDisputeDialog
            transactionType="booking"
            transactionId={bookingId}
            triggerLabel={t('actions.raiseDispute')}
            className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#8B1A1A] hover:underline"
          />
        )}
      </div>
    </div>
  )
}
