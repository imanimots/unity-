'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Check, X, Repeat, Ban, MessageCircle, CreditCard, PackageCheck, Truck, PartyPopper } from 'lucide-react'
import type { BarterStatus } from '@/types'
import { OpenDisputeDialog } from '@/components/disputes/open-dispute-dialog'
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

const ACTION_META: Record<ActionKind, { label: string; icon: typeof Check; classes: string; promptReason?: boolean }> = {
  accept: { label: 'Accept', icon: Check, classes: 'bg-green-600 hover:bg-green-700 text-white' },
  counter: { label: 'Counter', icon: Repeat, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  reject: { label: 'Decline', icon: X, classes: 'border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]', promptReason: true },
  cancel: { label: 'Cancel trade', icon: Ban, classes: 'border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]', promptReason: true },
  'pay-deposit': { label: 'Pay deposit', icon: CreditCard, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'pay-cash-adjustment': { label: 'Pay cash adjustment', icon: CreditCard, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'mark-preparing': { label: 'Start preparing', icon: PackageCheck, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'mark-in-transit': { label: 'Mark as shipped', icon: Truck, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'mark-ready': { label: 'Ready to exchange', icon: PackageCheck, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'confirm-completion': { label: 'Confirm completion', icon: PartyPopper, classes: 'bg-green-600 hover:bg-green-700 text-white' },
}

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
  const [pending, setPending] = useState<ActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const hasConfirmed = confirmations.some((c) => c.party_id === currentUserId)
  const actions = availableActions(status, isCurrentProposer, currentUserId, partyAId, partyBId, acceptedOffer, payments, hasConfirmed)
  const showDispute = DISPUTABLE_STATUSES.includes(status)

  async function run(action: Exclude<ActionKind, 'counter'>) {
    const meta = ACTION_META[action]
    let reason: string | null = null
    if (meta.promptReason) {
      reason = window.prompt(action === 'reject' ? 'Reason for declining (optional):' : 'Reason for cancelling (optional):')
      if (reason === null) return
    }

    setPending(action)
    setError(null)
    try {
      const body: Record<string, unknown> = { idempotency_key: crypto.randomUUID() }
      if (action === 'reject' && reason) body.rejection_reason = reason
      if (action === 'cancel' && reason) body.cancellation_reason = reason
      if (PROGRESS_TARGET[action]) body.target_status = PROGRESS_TARGET[action]

      const path = ACTION_ROUTE[action] ? ACTION_ROUTE[action]!(agreementId) : `/api/barter/${agreementId}/${action}`
      const res = await fetch(path, {
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
    <div className="mt-4 pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const meta = ACTION_META[action]
          const Icon = meta.icon
          if (action === 'counter') {
            return (
              <button
                key={action}
                onClick={onCounterClick}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors ${meta.classes}`}
              >
                <Icon size={13} /> {meta.label}
              </button>
            )
          }
          return (
            <button
              key={action}
              onClick={() => run(action)}
              disabled={pending !== null}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors disabled:opacity-50 ${meta.classes}`}
            >
              <Icon size={13} /> {pending === action ? 'Working…' : meta.label}
            </button>
          )
        })}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Link
          href={`/chat?barter=${agreementId}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] dark:text-[#9B8B85] hover:underline"
        >
          <MessageCircle size={13} /> Message
        </Link>
        {showDispute && (
          <OpenDisputeDialog
            transactionType="barter"
            transactionId={agreementId}
            className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#8B1A1A] hover:underline"
          />
        )}
      </div>
    </div>
  )
}
