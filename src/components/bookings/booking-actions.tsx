'use client'

import { useState } from 'react'
import { useRouter, Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Check, X, Play, PackageCheck, Ban, CreditCard, MessageCircle, Camera } from 'lucide-react'
import type { BookingLifecycleStatus } from '@/lib/bookings/status-labels'
import { OpenDisputeDialog } from '@/components/disputes/open-dispute-dialog'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'

/** Pre-handover condition evidence is eligible at these statuses --
 * mirrors src/lib/bookings/evidence-eligibility.ts's PRE_HANDOVER_ELIGIBLE_STATUSES
 * exactly, so this link only ever appears when the page behind it would
 * actually let the user upload something. */
const PRE_HANDOVER_EVIDENCE_STATUSES: BookingLifecycleStatus[] = ['accepted', 'active']
/** Post-return condition evidence is eligible from return_pending onward
 * (see evidence-eligibility.ts's POST_RETURN_ELIGIBLE_STATUSES) -- this
 * component only renders actions through return_pending, so that's the
 * one status where surfacing the link here actually matters. */
const POST_RETURN_EVIDENCE_STATUSES: BookingLifecycleStatus[] = ['return_pending']

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

const ACTION_META: Record<ActionKind, { labelKey: string; icon: typeof Check; classes: string }> = {
  accept: { labelKey: 'accept', icon: Check, classes: 'bg-green-600 hover:bg-green-700 text-white' },
  reject: { labelKey: 'decline', icon: X, classes: 'border border-[#F2EDE8] text-[#1A0A0A] hover:bg-[#FAF8F5]' },
  cancel: { labelKey: 'cancelBooking', icon: Ban, classes: 'border border-[#F2EDE8] text-[#1A0A0A] hover:bg-[#FAF8F5]' },
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

/** Actions whose consequences must be disclosed before firing -- see the
 * customer-journey mapping's systemic "no confirmation dialog anywhere"
 * finding. "accept"/"start" are deliberately excluded: they're
 * commitments the actor is actively seeking, not a destructive/
 * irreversible change to something already agreed. */
const CONSEQUENTIAL_ACTIONS: ActionKind[] = ['reject', 'cancel', 'confirm-return']

export function BookingActions({ bookingId, status, role, financiallyReady = false }: Props) {
  const router = useRouter()
  const t = useTranslations('rent')
  const tErrors = useTranslations('errors')
  const [pending, setPending] = useState<ActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ActionKind | null>(null)
  const [reason, setReason] = useState('')

  const actions = availableActions(status, role, financiallyReady)
  const showDispute = DISPUTABLE_STATUSES.includes(status)
  const showPreHandoverEvidence = PRE_HANDOVER_EVIDENCE_STATUSES.includes(status)
  const showPostReturnEvidence = POST_RETURN_EVIDENCE_STATUSES.includes(status)
  const mediaBase = role === 'renter' ? '/dashboard/renter/bookings' : '/dashboard/merchant/bookings'

  async function run(action: ActionKind, actionReason: string | null) {
    setPending(action)
    setError(null)
    try {
      const body: Record<string, string> = { idempotency_key: crypto.randomUUID() }
      if (action === 'reject' && actionReason) body.rejection_reason = actionReason
      if (action === 'cancel' && actionReason) body.cancellation_reason = actionReason

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
      setConfirming(null)
      setReason('')
      router.refresh()
    } catch {
      setError(tErrors('network'))
    } finally {
      setPending(null)
    }
  }

  function handleClick(action: ActionKind) {
    if (CONSEQUENTIAL_ACTIONS.includes(action)) {
      setError(null)
      setReason('')
      setConfirming(action)
      return
    }
    run(action, null)
  }

  /** Real, state-derived consequence text -- never a hardcoded refund
   * promise. `financiallyReady` already reflects whether payment has
   * actually been collected on this booking (see the Props doc comment
   * above), so cancelling before vs. after payment gets genuinely
   * different, accurate copy instead of one invented sentence. */
  function consequenceFor(action: ActionKind): string {
    if (action === 'reject') {
      return 'This booking has not been paid for yet -- declining it notifies the renter and ends the request. No payment is affected.'
    }
    if (action === 'cancel') {
      return financiallyReady
        ? 'This booking has already been paid for. Cancelling now follows Unity’s standard cancellation and refund policy for the stage this booking is at.'
        : 'No payment has been collected on this booking yet, so cancelling now does not involve a refund.'
    }
    return 'Confirming triggers deposit release once the item’s condition is reviewed, and finalizes this booking as returned.'
  }

  const dialogMeta: Record<string, { title: string; confirmLabel: string }> = {
    reject: { title: 'Decline this booking request?', confirmLabel: 'Decline request' },
    cancel: { title: 'Cancel this booking?', confirmLabel: 'Cancel booking' },
    'confirm-return': { title: 'Confirm this item was returned?', confirmLabel: 'Confirm return' },
  }

  return (
    <div className="mt-4 pt-4 border-t border-[#F2EDE8]">
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
              onClick={() => handleClick(action)}
              disabled={pending !== null}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors disabled:opacity-50 ${meta.classes}`}
            >
              <Icon size={13} /> {pending === action ? t('actions.working') : label}
            </button>
          )
        })}
      </div>
      {error && !confirming && <p className="text-xs text-red-600 mt-2">{error}</p>}

      {(showPreHandoverEvidence || showPostReturnEvidence) && (
        <div className="mt-3">
          <Link
            href={`${mediaBase}/${bookingId}/media`}
            className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#8B1A1A] hover:underline"
          >
            <Camera size={13} /> {showPreHandoverEvidence ? 'Document item condition' : 'Add return evidence'}
          </Link>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Link
          href={`/chat?booking=${bookingId}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] hover:underline"
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

      {confirming && (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => !open && setConfirming(null)}
          title={dialogMeta[confirming].title}
          consequence={consequenceFor(confirming)}
          reason={
            confirming === 'confirm-return'
              ? undefined
              : {
                  value: reason,
                  onChange: setReason,
                  label: 'Reason (optional)',
                  placeholder: confirming === 'reject' ? 'Let the renter know why' : 'Let the other party know why',
                }
          }
          confirmLabel={dialogMeta[confirming].confirmLabel}
          destructive={confirming !== 'confirm-return'}
          submitting={pending === confirming}
          error={error}
          onConfirm={() => run(confirming, reason.trim() || null)}
        />
      )}
    </div>
  )
}
