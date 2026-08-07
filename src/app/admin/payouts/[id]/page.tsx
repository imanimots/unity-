import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminPayoutDetail } from '@/lib/admin/payouts-service'
import { AdminPageHeader, formatDateTime, formatMoney } from '@/components/admin/ui'
import { PAYOUT_STATUS_LABELS, type PayoutStatus } from '@/lib/payouts/status-labels'
import { PayoutActions } from '@/components/admin/payout-actions'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Merchant Payout — Unity Admin' }

/**
 * Step 11 Phase 8 -- admin overrides only: mark-processing/mark-paid/
 * mark-failed/retry. No direct edit path exists anywhere for the
 * original amount/currency/merchant/booking/created_at (Core Principle 5).
 */
export default async function AdminPayoutDetailPage({ params }: PageProps) {
  const { id: payoutId } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminPayoutDetail(admin, payoutId)
  if (!detail) notFound()

  const { payout, merchantName, merchantAccountStatus, booking, listingTitle, rentalPayment, depositPayment, disputes, history, emailDeliveries } = detail
  const p = payout as unknown as {
    id: string
    status: PayoutStatus
    amount: number
    currency: string
    provider_reference: string | null
    payout_method: string | null
    attempt_count: number
    failure_category: string | null
    failure_message_safe: string | null
    created_at: string
    processing_started_at: string | null
    paid_at: string | null
    failed_at: string | null
  }
  const b = booking as unknown as { id: string; booking_reference: string; start_at: string; end_at: string; status: string; renter_id: string } | null
  const rp = rentalPayment as unknown as { status: string; amount: number; currency: string } | null
  const dp = depositPayment as unknown as { status: string; amount: number; currency: string } | null

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/payouts" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to payouts
      </Link>

      <AdminPageHeader eyebrow="Marketplace" title={`Payout — ${listingTitle ?? 'Booking'}`} badge={PAYOUT_STATUS_LABELS[p.status]?.label ?? p.status} />

      <div className="max-w-3xl space-y-8">
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Payout</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Amount</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold">{formatMoney(p.amount, p.currency)}</dd>
            <dt className="text-[#9B8B85]">Attempt count</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{p.attempt_count}</dd>
            <dt className="text-[#9B8B85]">Payout method</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{p.payout_method ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Payout reference</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{p.provider_reference ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Created</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(p.created_at)}</dd>
            {p.processing_started_at && (
              <>
                <dt className="text-[#9B8B85]">Processing started</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(p.processing_started_at)}</dd>
              </>
            )}
            {p.paid_at && (
              <>
                <dt className="text-[#9B8B85]">Paid</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(p.paid_at)}</dd>
              </>
            )}
            {p.failed_at && (
              <>
                <dt className="text-[#9B8B85]">Failed</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(p.failed_at)}</dd>
              </>
            )}
            {p.failure_category && (
              <>
                <dt className="text-[#9B8B85]">Failure category</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{p.failure_category}</dd>
              </>
            )}
          </dl>
          <p className="text-xs text-[#9B8B85] mt-2">
            Amount, currency, merchant, and source booking are immutable snapshots — corrections happen through failure/retry or append-only history, never a direct edit.
          </p>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Merchant</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Name</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{merchantName ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Account status</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{merchantAccountStatus ?? '—'}</dd>
          </dl>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Source booking</h2>
          {b ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <dt className="text-[#9B8B85]">Reference</dt>
              <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]"><Link href={`/admin/bookings/${b.id}`} className="hover:underline">{b.booking_reference}</Link></dd>
              <dt className="text-[#9B8B85]">Listing</dt>
              <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{listingTitle ?? '—'}</dd>
              <dt className="text-[#9B8B85]">Rental dates</dt>
              <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(b.start_at)} – {formatDateTime(b.end_at)}</dd>
              <dt className="text-[#9B8B85]">Booking status</dt>
              <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{b.status}</dd>
            </dl>
          ) : (
            <p className="text-sm text-[#9B8B85]">No source booking on record.</p>
          )}
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Financials</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Rental payment</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{rp ? `${formatMoney(rp.amount, rp.currency)} (${rp.status})` : '—'}</dd>
            <dt className="text-[#9B8B85]">Deposit (shown separately, never included)</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{dp ? `${formatMoney(dp.amount, dp.currency)} (${dp.status})` : 'None'}</dd>
            <dt className="text-[#9B8B85]">Payout amount</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold">{formatMoney(p.amount, p.currency)}</dd>
          </dl>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Disputes ({disputes.length})</h2>
          {disputes.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No disputes on this booking.</p>
          ) : (
            <ul className="space-y-2">
              {disputes.map((d) => {
                const row = d as unknown as { id: string; status: string; created_at: string }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <Link href={`/admin/disputes/${row.id}`} className="text-[#1A0A0A] dark:text-[#F5F0ED] hover:underline capitalize">{row.status}</Link>
                    <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(row.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Admin actions</h2>
          <PayoutActions payoutId={p.id} status={p.status} />
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Immutable history</h2>
          {history.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No history recorded yet — this payout has not been processed.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((h) => {
                const row = h as unknown as { id: string; previous_status: string | null; new_status: string; actor_type: string; reason: string | null; created_at: string }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">
                      {row.previous_status ? `${row.previous_status} → ${row.new_status}` : row.new_status}
                      <span className="text-[#9B8B85]"> — {row.actor_type}{row.reason ? `: ${row.reason}` : ''}</span>
                    </span>
                    <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(row.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Email deliveries ({emailDeliveries.length})</h2>
          {emailDeliveries.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No emails sent for this payout yet.</p>
          ) : (
            <ul className="space-y-2">
              {emailDeliveries.map((e) => {
                const row = e as unknown as { id: string; event_type: string; status: string; created_at: string }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{row.event_type} — {row.status}</span>
                    <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(row.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
