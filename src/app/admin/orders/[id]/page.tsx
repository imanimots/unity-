import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminOrderDetail } from '@/lib/admin/orders-service'
import { AdminPageHeader, Pill, ACCOUNT_STATUS_STYLES, formatDate, formatDateTime, formatMoney } from '@/components/admin/ui'
import { ChatThread } from '@/components/messaging/chat-thread'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Order — Unity Admin' }

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700',
  paid: 'bg-blue-100 text-blue-700',
  shipped: 'bg-blue-100 text-blue-700',
  delivered: 'bg-green-100 text-green-700',
  disputed: 'bg-red-100 text-red-700',
  cancelled: 'bg-[#F2EDE8] text-[#9B8B85]',
}

/**
 * Step 11 Phase 6 -- read-only monitoring only (Part C): no lifecycle
 * override, no way to mark payment successful, ship, or complete an
 * order from here. The MESSAGES section embeds ChatThread with
 * useAdminEndpoint=true, routing through the audited GET
 * /api/admin/messages exactly the way the dispute admin detail page
 * already does -- never a direct query, never the participant endpoint
 * (correction 16).
 */
export default async function AdminOrderDetailPage({ params }: PageProps) {
  const { id: orderId } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminOrderDetail(admin, orderId)
  if (!detail) notFound()

  const { order, financial, history, dispute, emailDeliveries, buyer, seller } = detail
  const payment = financial.payment as { status?: string; payment_type?: string; provider?: string; failure_reason?: string } | null

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/orders" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to orders
      </Link>

      <AdminPageHeader eyebrow="Marketplace" title={`Order ${order.orderReference}`} badge={order.status} />

      <div className="max-w-3xl space-y-8">
        {/* ORDER */}
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Order</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Listing</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{order.listingTitle ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Status</dt>
            <dd><Pill value={order.status} styles={STATUS_STYLES} /></dd>
            <dt className="text-[#9B8B85]">Created</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(order.createdAt)}</dd>
            <dt className="text-[#9B8B85]">Listing delivery capabilities</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{order.deliveryMethodHint}</dd>
            <dt className="text-[#9B8B85]">Quantity</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{order.quantity}</dd>
            <dt className="text-[#9B8B85]">Last event</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{order.lastLifecycleEvent ?? '—'}</dd>
          </dl>
        </section>

        {/* FINANCIALS */}
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Financials</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Unit price</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatMoney(order.unitPrice, order.currency)}</dd>
            <dt className="text-[#9B8B85]">Shipping fee</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatMoney(order.shippingFee, order.currency)}</dd>
            <dt className="text-[#9B8B85]">Total</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold">{formatMoney(order.totalAmount, order.currency)}</dd>
            <dt className="text-[#9B8B85]">Payment status</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{payment?.status ?? 'not started'}</dd>
            <dt className="text-[#9B8B85]">Payment type</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{payment?.payment_type ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Provider</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{payment?.provider ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Attempts</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{financial.attempts.length}</dd>
            <dt className="text-[#9B8B85]">Ledger entries</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{financial.ledgerEntryCount}</dd>
            <dt className="text-[#9B8B85]">Payout status</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">N/A</dd>
          </dl>
          <p className="text-xs text-[#9B8B85] mt-2">
            Payout status is not applicable — order-linked merchant payouts are not tracked in the current schema.
          </p>
        </section>

        {/* HISTORY */}
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">History</h2>
          {history.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No history recorded.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((h) => (
                <li key={h.id} className="text-sm flex items-baseline justify-between gap-4">
                  <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">
                    {h.eventType.replace(/_/g, ' ')} {h.previousStatus ? `(${h.previousStatus} → ${h.newStatus})` : `(${h.newStatus})`}
                    {h.actorRole ? <span className="text-[#9B8B85]"> — {h.actorRole}</span> : null}
                  </span>
                  <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(h.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* DISPUTES */}
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Dispute</h2>
          {dispute ? (
            <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
              &ldquo;{dispute.title}&rdquo; — {dispute.status}.{' '}
              <Link href={`/admin/disputes/${dispute.id}`} className="text-[#8B1A1A] hover:underline">
                View dispute
              </Link>
            </p>
          ) : (
            <p className="text-sm text-[#9B8B85]">No dispute has been raised on this order.</p>
          )}
        </section>

        {/* MESSAGES -- audited admin read, never a direct query (correction 16) */}
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">Messages</h2>
          <ChatThread
            transactionType="order"
            transactionId={order.id}
            currentUserId={requester.userId}
            canSend={false}
            variant="embedded"
            useAdminEndpoint
          />
        </section>

        {/* EMAILS */}
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Email deliveries</h2>
          {emailDeliveries.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No emails sent for this order yet.</p>
          ) : (
            <ul className="space-y-2">
              {emailDeliveries.map((e) => (
                <li key={e.id} className="text-sm flex items-baseline justify-between gap-4">
                  <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{e.eventType}</span>
                  <span className="text-[#9B8B85] whitespace-nowrap">
                    {e.status} — {formatDate(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/admin/email-deliveries" className="text-xs text-[#8B1A1A] hover:underline mt-2 inline-block">
            View in email delivery admin
          </Link>
        </section>

        {/* PARTICIPANTS */}
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Participants</h2>
          <div className="grid grid-cols-2 gap-6 text-sm">
            <div>
              <p className="text-[#9B8B85] mb-1">Buyer</p>
              <p className="text-[#1A0A0A] dark:text-[#F5F0ED]">{buyer.name ?? buyer.id}</p>
              <div className="mt-1 flex gap-2">
                {buyer.accountStatus && <Pill value={buyer.accountStatus} styles={ACCOUNT_STATUS_STYLES} />}
                <span className="text-xs text-[#9B8B85]">KYC: {buyer.kycStatus ?? 'unknown'}</span>
              </div>
            </div>
            <div>
              <p className="text-[#9B8B85] mb-1">Seller</p>
              <p className="text-[#1A0A0A] dark:text-[#F5F0ED]">{seller.name ?? seller.id}</p>
              <div className="mt-1 flex gap-2">
                {seller.accountStatus && <Pill value={seller.accountStatus} styles={ACCOUNT_STATUS_STYLES} />}
                <span className="text-xs text-[#9B8B85]">KYC: {seller.kycStatus ?? 'unknown'}</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
