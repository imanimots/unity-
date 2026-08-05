import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Clock, Package } from 'lucide-react'
import { requireMerchant } from '@/lib/supabase/require-admin'
import { OrderStatusBadge } from '@/components/orders/order-status-badge'
import { OrderActions } from '@/components/orders/order-actions'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import type { OrderStatus } from '@/types'

export const metadata = { title: 'My Sales — Unity' }

interface OrderRow {
  id: string
  order_reference: string
  listing_id: string
  quantity: number
  unit_price: number
  total_amount: number
  status: OrderStatus
  created_at: string
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default async function MySalesPage() {
  const requester = await requireMerchant()
  if (!requester) redirect('/login?redirectTo=/dashboard/merchant/orders')

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const { data } = supabase
    ? await supabase
        .from('orders')
        .select('id, order_reference, listing_id, quantity, unit_price, total_amount, status, created_at')
        .eq('seller_id', requester.userId)
        .order('created_at', { ascending: false })
    : { data: [] as OrderRow[] }

  const orders = (data ?? []) as OrderRow[]
  const listingIds = Array.from(new Set(orders.map((o) => o.listing_id)))
  const { data: listings } = supabase && listingIds.length > 0
    ? await supabase.from('listings').select('id, title').in('id', listingIds)
    : { data: [] as { id: string; title: string }[] }
  const titleById = new Map((listings ?? []).map((l) => [l.id, l.title]))

  const pendingCount = orders.filter((o) => o.status === 'paid').length
  const earnedTotal = orders.filter((o) => o.status === 'delivered').reduce((sum, o) => sum + o.total_amount, 0)

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Selling</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">Sales</h1>
      </div>

      <TestModeBanner className="mb-8" />

      <div className="grid grid-cols-2 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">To ship</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-amber-500 leading-none">{pendingCount}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">Earned (delivered)</p>
          <div className="text-4xl lg:text-5xl font-extrabold text-[#8B1A1A] leading-none">R{earnedTotal}</div>
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Package size={36} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">No sales yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <div key={order.id} className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
              <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
                <Link href={`/listings/${order.listing_id}`} className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] hover:underline">
                  Order {order.order_reference} — {titleById.get(order.listing_id) ?? 'Listing'}
                </Link>
                <OrderStatusBadge status={order.status} />
              </div>
              <p className="text-xs text-[#9B8B85] flex items-center gap-1.5">
                <Clock size={11} /> Placed {fmt(order.created_at)}
              </p>
              <p className="text-xs font-semibold text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                {order.quantity} × R{order.unit_price} · total R{order.total_amount}
              </p>

              <OrderActions orderId={order.id} status={order.status} role="seller" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
