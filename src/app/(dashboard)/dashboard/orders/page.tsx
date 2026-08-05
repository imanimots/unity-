import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Clock, Package } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { OrderStatusBadge } from '@/components/orders/order-status-badge'
import { OrderActions } from '@/components/orders/order-actions'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import type { OrderStatus } from '@/types'

export const metadata = { title: 'My Purchases — Unity' }

interface OrderRow {
  id: string
  order_reference: string
  listing_id: string
  quantity: number
  unit_price: number
  shipping_fee: number
  total_amount: number
  status: OrderStatus
  created_at: string
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default async function MyPurchasesPage() {
  const requester = await requireAuth()
  if (!requester) redirect('/login?redirectTo=/dashboard/orders')

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const { data } = supabase
    ? await supabase
        .from('orders')
        .select('id, order_reference, listing_id, quantity, unit_price, shipping_fee, total_amount, status, created_at')
        .eq('buyer_id', requester.userId)
        .order('created_at', { ascending: false })
    : { data: [] as OrderRow[] }

  const orders = (data ?? []) as OrderRow[]
  const listingIds = Array.from(new Set(orders.map((o) => o.listing_id)))
  const { data: listings } = supabase && listingIds.length > 0
    ? await supabase.from('listings').select('id, title').in('id', listingIds)
    : { data: [] as { id: string; title: string }[] }
  const titleById = new Map((listings ?? []).map((l) => [l.id, l.title]))

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Buying</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">My Purchases</h1>
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mt-3">
          {orders.length} order{orders.length !== 1 ? 's' : ''} total
        </p>
      </div>

      <TestModeBanner className="mb-8" />

      {orders.length === 0 ? (
        <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-16 text-center">
          <Package size={36} className="mx-auto text-[#9B8B85] mb-4" />
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">No purchases yet</p>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-6">Browse listings for sale and make your first purchase.</p>
          <Link href="/listings?mode=buy" className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8B1A1A] text-white font-semibold uppercase text-xs tracking-[0.1em] rounded-xl hover:bg-[#7A1616] transition-colors">
            Browse For Sale
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
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
              <p className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mt-0.5">
                {order.quantity} × R{order.unit_price} · total R{order.total_amount}
              </p>

              <OrderActions orderId={order.id} status={order.status} role="buyer" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
