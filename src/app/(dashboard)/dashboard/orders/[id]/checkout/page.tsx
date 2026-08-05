import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { isMockScenarioSelectionAllowed } from '@/lib/checkout/test-scenario'
import { OrderCheckoutFlow } from './checkout-flow'

export const metadata = { title: 'Checkout — Unity' }

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function OrderCheckoutPage({ params }: PageProps) {
  const { id: orderId } = await params
  const requester = await requireAuth()
  if (!requester) redirect(`/login?redirectTo=/dashboard/orders/${orderId}/checkout`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) notFound()

  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const { data: order } = await admin
    .from('orders')
    .select('order_reference, listing_id, buyer_id, quantity, unit_price, shipping_fee, total_amount, status')
    .eq('id', orderId)
    .maybeSingle()

  if (!order || order.buyer_id !== requester.userId) notFound()

  const { data: listing } = await admin.from('listings').select('title, merchant_id').eq('id', order.listing_id).maybeSingle()
  const { data: sellerProfile } = listing
    ? await admin.from('profiles').select('display_name, full_name').eq('id', listing.merchant_id).maybeSingle()
    : { data: null }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
      <Link
        href="/dashboard/orders"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] mb-6"
      >
        <ArrowLeft size={13} /> Back to purchases
      </Link>

      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Secure Checkout</p>
        <h1 className="text-3xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">Complete payment</h1>
      </div>

      <OrderCheckoutFlow
        orderId={orderId}
        initial={{
          orderReference: order.order_reference,
          listingTitle: listing?.title ?? 'Listing',
          sellerDisplayName: sellerProfile?.display_name ?? sellerProfile?.full_name ?? 'Seller',
          quantity: order.quantity,
          unitPrice: order.unit_price,
          shippingFee: order.shipping_fee,
          totalAmount: order.total_amount,
          currency: 'ZAR',
          status: order.status,
          testModeAvailable: isMockScenarioSelectionAllowed(),
        }}
      />
    </div>
  )
}
