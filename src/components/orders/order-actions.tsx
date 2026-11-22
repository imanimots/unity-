'use client'

import { useState } from 'react'
import { useRouter, Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Truck, PackageCheck, Ban, CreditCard, MessageCircle } from 'lucide-react'
import type { OrderStatus } from '@/types'
import { OpenDisputeDialog } from '@/components/disputes/open-dispute-dialog'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'

/** A dispute only makes sense once payment/shipment has actually happened. */
const DISPUTABLE_STATUSES: OrderStatus[] = ['shipped', 'delivered']

interface Props {
  orderId: string
  status: OrderStatus
  role: 'buyer' | 'seller'
}

type ActionKind = 'checkout' | 'ship' | 'confirm-delivery' | 'cancel'

const ACTION_META: Record<ActionKind, { labelKey: string; icon: typeof Truck; classes: string }> = {
  checkout: { labelKey: 'payNow', icon: CreditCard, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  ship: { labelKey: 'markAsShipped', icon: Truck, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'confirm-delivery': { labelKey: 'confirmReceived', icon: PackageCheck, classes: 'bg-green-600 hover:bg-green-700 text-white' },
  cancel: { labelKey: 'cancelOrder', icon: Ban, classes: 'border border-[#F2EDE8] text-[#1A0A0A] hover:bg-[#FAF8F5]' },
}

/** Consequential actions needing disclosure before firing -- "ship" is
 * excluded: it's the seller progressing their own commitment, not an
 * irreversible change to the buyer's position. */
const CONSEQUENTIAL_ACTIONS: ActionKind[] = ['cancel', 'confirm-delivery']

/**
 * Which actions are available, mirroring the RPC transition rules in
 * supabase/migrations/20260812000004_order_rpcs.sql exactly -- the RPC
 * is the real enforcement point, this only decides which buttons to show.
 */
function availableActions(status: OrderStatus, role: 'buyer' | 'seller'): ActionKind[] {
  if (role === 'buyer') {
    if (status === 'pending') return ['checkout', 'cancel']
    if (status === 'paid') return ['cancel']
    if (status === 'shipped') return ['confirm-delivery']
    return []
  }
  // seller
  if (status === 'pending') return []
  if (status === 'paid') return ['ship', 'cancel']
  return []
}

export function OrderActions({ orderId, status, role }: Props) {
  const router = useRouter()
  const t = useTranslations('buy.actions')
  const tErrors = useTranslations('errors')
  const tDisputes = useTranslations('common.disputes')
  const [pending, setPending] = useState<ActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const actions = availableActions(status, role)
  const showDispute = DISPUTABLE_STATUSES.includes(status)
  const [confirming, setConfirming] = useState<Exclude<ActionKind, 'checkout'> | null>(null)
  const [reason, setReason] = useState('')

  async function run(action: Exclude<ActionKind, 'checkout'>, actionReason: string | null) {
    setPending(action)
    setError(null)
    try {
      const body: Record<string, string> = { idempotency_key: crypto.randomUUID() }
      if (action === 'cancel' && actionReason) body.cancellation_reason = actionReason

      const res = await fetch(`/api/orders/${orderId}/${action}`, {
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

  function handleClick(action: Exclude<ActionKind, 'checkout'>) {
    if (CONSEQUENTIAL_ACTIONS.includes(action)) {
      setError(null)
      setReason('')
      setConfirming(action)
      return
    }
    run(action, null)
  }

  /** Real, state-derived consequence text -- `status` already tells us
   * directly whether payment has been collected (pending = not paid;
   * paid/shipped = paid), so this never has to guess. confirm_order_
   * delivery (supabase/migrations/20260812000004_order_rpcs.sql) only
   * changes status and starts the review-eligibility window -- it does
   * not itself release any payment, so the copy below doesn't claim it does. */
  function consequenceFor(action: Exclude<ActionKind, 'checkout'>): string {
    if (action === 'cancel') {
      return status === 'pending'
        ? 'No payment has been collected on this order yet, so cancelling now does not involve a refund.'
        : 'This order has already been paid for. Cancelling now follows Unity’s standard cancellation and refund policy for the stage this order is at.'
    }
    return 'Confirms the item arrived as described and starts the window during which you can leave a review. This does not retract your order -- contact support or raise a dispute if something is actually wrong with the item.'
  }

  const dialogMeta: Record<string, { title: string; confirmLabel: string; destructive: boolean }> = {
    cancel: { title: 'Cancel this order?', confirmLabel: 'Cancel order', destructive: true },
    'confirm-delivery': { title: 'Confirm you received this item?', confirmLabel: 'Confirm received', destructive: false },
  }

  return (
    <div className="mt-4 pt-4 border-t border-[#F2EDE8]">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const meta = ACTION_META[action]
          const Icon = meta.icon
          const label = t(meta.labelKey)
          if (action === 'checkout') {
            return (
              <Link
                key={action}
                href={`/dashboard/orders/${orderId}/checkout`}
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
              <Icon size={13} /> {pending === action ? t('working') : label}
            </button>
          )
        })}
      </div>
      {error && !confirming && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Link
          href={`/chat?order=${orderId}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] hover:underline"
        >
          <MessageCircle size={13} /> {t('message')}
        </Link>
        {showDispute && (
          <OpenDisputeDialog
            transactionType="order"
            transactionId={orderId}
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
            confirming === 'cancel'
              ? { value: reason, onChange: setReason, label: 'Reason (optional)', placeholder: 'Let the other party know why' }
              : undefined
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
