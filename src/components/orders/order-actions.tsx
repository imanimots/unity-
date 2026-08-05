'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Truck, PackageCheck, Ban, CreditCard, MessageCircle } from 'lucide-react'
import type { OrderStatus } from '@/types'
import { OpenDisputeDialog } from '@/components/disputes/open-dispute-dialog'

/** A dispute only makes sense once payment/shipment has actually happened. */
const DISPUTABLE_STATUSES: OrderStatus[] = ['shipped', 'delivered']

interface Props {
  orderId: string
  status: OrderStatus
  role: 'buyer' | 'seller'
}

type ActionKind = 'checkout' | 'ship' | 'confirm-delivery' | 'cancel'

const ACTION_META: Record<ActionKind, { label: string; icon: typeof Truck; classes: string; promptReason?: boolean }> = {
  checkout: { label: 'Pay now', icon: CreditCard, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  ship: { label: 'Mark as shipped', icon: Truck, classes: 'bg-[#8B1A1A] hover:bg-[#7A1616] text-white' },
  'confirm-delivery': { label: 'Confirm received', icon: PackageCheck, classes: 'bg-green-600 hover:bg-green-700 text-white' },
  cancel: { label: 'Cancel order', icon: Ban, classes: 'border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]', promptReason: true },
}

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
  const [pending, setPending] = useState<ActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const actions = availableActions(status, role)
  const showDispute = DISPUTABLE_STATUSES.includes(status)

  async function run(action: Exclude<ActionKind, 'checkout'>) {
    const meta = ACTION_META[action]
    let reason: string | null = null
    if (meta.promptReason) {
      reason = window.prompt('Reason for cancelling (optional):')
      if (reason === null) return
    }

    setPending(action)
    setError(null)
    try {
      const body: Record<string, string> = { idempotency_key: crypto.randomUUID() }
      if (action === 'cancel' && reason) body.cancellation_reason = reason

      const res = await fetch(`/api/orders/${orderId}/${action}`, {
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
          if (action === 'checkout') {
            return (
              <Link
                key={action}
                href={`/dashboard/orders/${orderId}/checkout`}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg transition-colors ${meta.classes}`}
              >
                <Icon size={13} /> {meta.label}
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
              <Icon size={13} /> {pending === action ? 'Working…' : meta.label}
            </button>
          )
        })}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Link
          href={`/chat?order=${orderId}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] dark:text-[#9B8B85] hover:underline"
        >
          <MessageCircle size={13} /> Message
        </Link>
        {showDispute && (
          <OpenDisputeDialog
            transactionType="order"
            transactionId={orderId}
            className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#8B1A1A] hover:underline"
          />
        )}
      </div>
    </div>
  )
}
