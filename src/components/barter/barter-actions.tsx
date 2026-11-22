'use client'

import { useState } from 'react'
import { useRouter, Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Check, X, Repeat, Ban, MessageCircle, CreditCard, PackageCheck, Truck, PartyPopper } from 'lucide-react'
import type { BarterStatus } from '@/types'
import { OpenDisputeDialog } from '@/components/disputes/open-dispute-dialog'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { deriveBarterFinancialReadiness, type BarterDepositRequirement, type BarterPaymentStatus } from '@/lib/barter/financial-readiness'

function asPaymentStatus(status: string | undefined): BarterPaymentStatus {
  return (status ?? 'pending') as BarterPaymentStatus
}

/** A dispute only makes sense once the trade has actually been accepted. */
const DISPUTABLE_STATUSES: BarterStatus[] = ['accepted', 'preparing', 'in_transit', 'awaiting_confirmation', 'completed']

interface AcceptedOfferFields {
  delivery_method: string
  deposit_required: boolean
  deposit_payer: 'party_a' | 'party_b' | 'both' | null
  cash_adjustment_amount: number
  cash_adjustment_payer: string | null
}

interface PaymentRow {
  payment_type: string
  renter_id: string
  /** Raw payments.status column value -- narrowed to BarterPaymentStatus only where deriveBarterFinancialReadiness() needs it. */
  status: string
}

interface Props {
  agreementId: string
  status: BarterStatus
  /** Whether the caller proposed the current pending offer (turn rule — the proposer cannot accept/counter/reject their own offer). */
  isCurrentProposer: boolean
  onCounterClick: () => void
  /** Step 11 Phase 4 additions -- everything needed to derive which financial/progress actions apply. */
  currentUserId: string
  partyAId: string
  partyBId: string
  acceptedOffer: AcceptedOfferFields | null
  payments: PaymentRow[]
  confirmations: { party_id: string }[]
}

type SimpleAction = 'accept' | 'reject' | 'cancel'
type ActionKind = SimpleAction | 'counter' | 'pay-deposit' | 'pay-cash-adjustment' | 'mark-preparing' | 'mark-in-transit' | 'mark-ready' | 'confirm-completion'

const ACTION_META: Record<ActionKind, { labelKey: string; icon: typeof Check; classes: string }> = {
  accept: { labelKey: 'accept', icon: Check, classes: 'bg-green-600 hover:bg-green-700 text-white' },
  counter: { labelKey: 'counter', icon: Repeat, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  reject: { labelKey: 'decline', icon: X, classes: 'border border-[#F2EDE8] text-[#1A0A0A] hover:bg-[#FAF8F5]' },
  cancel: { labelKey: 'cancelTrade', icon: Ban, classes: 'border border-[#F2EDE8] text-[#1A0A0A] hover:bg-[#FAF8F5]' },
  'pay-deposit': { labelKey: 'payDeposit', icon: CreditCard, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'pay-cash-adjustment': { labelKey: 'payCashAdjustment', icon: CreditCard, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'mark-preparing': { labelKey: 'startPreparing', icon: PackageCheck, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'mark-in-transit': { labelKey: 'markAsShipped', icon: Truck, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'mark-ready': { labelKey: 'readyToExchange', icon: PackageCheck, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'confirm-completion': { labelKey: 'confirmCompletion', icon: PartyPopper, classes: 'bg-green-600 hover:bg-green-700 text-white' },
}

/** Consequential actions needing disclosure before firing. */
const CONSEQUENTIAL_ACTIONS: ActionKind[] = ['reject', 'cancel', 'confirm-completion']

const ACTION_ROUTE: Partial<Record<ActionKind, (id: string) => string>> = {
  'pay-deposit': (id) => `/api/barter/${id}/deposit`,
  'pay-cash-adjustment': (id) => `/api/barter/${id}/cash-adjustment`,
  'mark-preparing': (id) => `/api/barter/${id}/progress`,
  'mark-in-transit': (id) => `/api/barter/${id}/progress`,
  'mark-ready': (id) => `/api/barter/${id}/progress`,
  'confirm-completion': (id) => `/api/barter/${id}/confirm-completion`,
}

const PROGRESS_TARGET: Partial<Record<ActionKind, string>> = {
  'mark-preparing': 'preparing',
  'mark-in-transit': 'in_transit',
  'mark-ready': 'awaiting_confirmation',
}

/**
 * Which actions are available, mirroring the RPC transition rules
 * exactly (Phase A propose/counter/accept/reject/cancel in
 * 20260810000011_barter_rpcs_phase_a.sql, Phase B pay/progress/confirm
 * in 20260816000003_barter_execution_rpcs.sql) -- the RPC is the real
 * enforcement point, this only decides which buttons to show.
 */
function availableActions(
  status: BarterStatus,
  isCurrentProposer: boolean,
  currentUserId: string,
  partyAId: string,
  partyBId: string,
  offer: AcceptedOfferFields | null,
  payments: PaymentRow[],
  hasConfirmed: boolean
): ActionKind[] {
  if (status === 'proposed' || status === 'countered') {
    return isCurrentProposer ? ['cancel'] : ['accept', 'counter', 'reject', 'cancel']
  }

  const actions: ActionKind[] = []

  if (status === 'accepted' || status === 'preparing' || status === 'in_transit' || status === 'awaiting_confirmation') {
    if (status === 'accepted' && offer) {
      const iAmA = currentUserId === partyAId
      const oweDeposit = offer.deposit_required && (offer.deposit_payer === 'both' || (offer.deposit_payer === 'party_a' && iAmA) || (offer.deposit_payer === 'party_b' && !iAmA))
      const myDeposit = payments.find((p) => p.payment_type === 'barter_deposit' && p.renter_id === currentUserId)
      if (oweDeposit && (!myDeposit || myDeposit.status === 'pending' || myDeposit.status === 'failed')) {
        actions.push('pay-deposit')
      }

      const oweCash = offer.cash_adjustment_amount > 0 && offer.cash_adjustment_payer === currentUserId
      const myCash = payments.find((p) => p.payment_type === 'barter_cash_adjustment' && p.renter_id === currentUserId)
      if (oweCash && (!myCash || myCash.status === 'pending' || myCash.status === 'failed')) {
        actions.push('pay-cash-adjustment')
      }

      const readiness = deriveBarterFinancialReadiness({
        depositRequirements: depositRequirementsFor(offer, partyAId, partyBId, payments),
        cashAdjustmentRequired: offer.cash_adjustment_amount > 0,
        cashAdjustmentStatus: asPaymentStatus(payments.find((p) => p.payment_type === 'barter_cash_adjustment')?.status),
      })
      if (readiness === 'financially_ready') actions.push('mark-preparing')
    }

    if (status === 'preparing' && offer) {
      if (offer.delivery_method === 'courier') actions.push('mark-in-transit')
      else actions.push('mark-ready')
    }

    if (status === 'in_transit') {
      actions.push('mark-ready')
    }

    if (status === 'awaiting_confirmation' && !hasConfirmed) {
      actions.push('confirm-completion')
    }

    actions.push('cancel')
  }

  return actions
}

function depositRequirementsFor(offer: AcceptedOfferFields, partyAId: string, partyBId: string, payments: PaymentRow[]): BarterDepositRequirement[] {
  if (!offer.deposit_required) return []
  const requirements: BarterDepositRequirement[] = []
  if (offer.deposit_payer === 'party_a' || offer.deposit_payer === 'both') {
    requirements.push({ payer: 'party_a', status: asPaymentStatus(payments.find((p) => p.payment_type === 'barter_deposit' && p.renter_id === partyAId)?.status) })
  }
  if (offer.deposit_payer === 'party_b' || offer.deposit_payer === 'both') {
    requirements.push({ payer: 'party_b', status: asPaymentStatus(payments.find((p) => p.payment_type === 'barter_deposit' && p.renter_id === partyBId)?.status) })
  }
  return requirements
}

export function BarterActions({ agreementId, status, isCurrentProposer, onCounterClick, currentUserId, partyAId, partyBId, acceptedOffer, payments, confirmations }: Props) {
  const router = useRouter()
  const t = useTranslations('barter.actions')
  const tErrors = useTranslations('errors')
  const tDisputes = useTranslations('common.disputes')
  const [pending, setPending] = useState<ActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const hasConfirmed = confirmations.some((c) => c.party_id === currentUserId)
  const actions = availableActions(status, isCurrentProposer, currentUserId, partyAId, partyBId, acceptedOffer, payments, hasConfirmed)
  const showDispute = DISPUTABLE_STATUSES.includes(status)
  const [confirming, setConfirming] = useState<Exclude<ActionKind, 'counter'> | null>(null)
  const [reason, setReason] = useState('')

  async function run(action: Exclude<ActionKind, 'counter'>, actionReason: string | null) {
    setPending(action)
    setError(null)
    try {
      const body: Record<string, unknown> = { idempotency_key: crypto.randomUUID() }
      if (action === 'reject' && actionReason) body.rejection_reason = actionReason
      if (action === 'cancel' && actionReason) body.cancellation_reason = actionReason
      if (PROGRESS_TARGET[action]) body.target_status = PROGRESS_TARGET[action]

      const path = ACTION_ROUTE[action] ? ACTION_ROUTE[action]!(agreementId) : `/api/barter/${agreementId}/${action}`
      const res = await fetch(path, {
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

  function handleClick(action: Exclude<ActionKind, 'counter'>) {
    if (CONSEQUENTIAL_ACTIONS.includes(action)) {
      setError(null)
      setReason('')
      setConfirming(action)
      return
    }
    run(action, null)
  }

  /** Real, state-derived consequence text. A deposit/cash-adjustment
   * payment existing in `payments` with a non-pending/non-failed status
   * means money has actually moved -- never assumed from the status
   * alone. confirm-completion's deposit release is grounded directly in
   * src/app/api/barter/[id]/confirm-completion/route.ts's own comment:
   * it only releases deposits once BOTH parties have confirmed, never
   * on a single confirmation. */
  function consequenceFor(action: Exclude<ActionKind, 'counter'>): string {
    if (action === 'reject') {
      return 'No payment has been made on this trade yet -- declining it notifies the other party and ends the proposal.'
    }
    if (action === 'cancel') {
      const somethingPaid = payments.some((p) => p.status !== 'pending' && p.status !== 'failed')
      return somethingPaid
        ? 'A deposit or cash adjustment has already been paid on this trade. Cancelling now follows Unity’s standard cancellation and refund policy for the stage this trade is at.'
        : 'No payment has been made on this trade yet, so cancelling now does not involve a refund.'
    }
    return 'If you’re the first to confirm, nothing finalizes yet -- the trade completes once the other party also confirms. Once both parties have confirmed, any deposit held for this trade is released.'
  }

  const dialogMeta: Record<string, { title: string; confirmLabel: string; destructive: boolean }> = {
    reject: { title: 'Decline this trade proposal?', confirmLabel: 'Decline trade', destructive: true },
    cancel: { title: 'Cancel this trade?', confirmLabel: 'Cancel trade', destructive: true },
    'confirm-completion': { title: 'Confirm this trade is complete?', confirmLabel: 'Confirm completion', destructive: false },
  }

  return (
    <div className="mt-4 pt-4 border-t border-[#F2EDE8]">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const meta = ACTION_META[action]
          const Icon = meta.icon
          const label = t(meta.labelKey)
          if (action === 'counter') {
            return (
              <button
                key={action}
                onClick={onCounterClick}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors ${meta.classes}`}
              >
                <Icon size={13} /> {label}
              </button>
            )
          }
          return (
            <button
              key={action}
              onClick={() => handleClick(action)}
              disabled={pending !== null}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors disabled:opacity-50 ${meta.classes}`}
            >
              <Icon size={13} /> {pending === action ? t('working') : label}
            </button>
          )
        })}
      </div>
      {error && !confirming && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Link
          href={`/chat?barter=${agreementId}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] hover:underline"
        >
          <MessageCircle size={13} /> {t('message')}
        </Link>
        {showDispute && (
          <OpenDisputeDialog
            transactionType="barter"
            transactionId={agreementId}
            triggerLabel={tDisputes('raiseDispute')}
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
            confirming === 'confirm-completion'
              ? undefined
              : { value: reason, onChange: setReason, label: 'Reason (optional)', placeholder: 'Let the other party know why' }
          }
          confirmLabel={dialogMeta[confirming].confirmLabel}
          destructive={dialogMeta[confirming].destructive}
          submitting={pending === confirming}
          error={error}
          onConfirm={() => run(confirming, reason.trim() || null)}
        />
      )}
    </div>
  )
}
