import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminAffiliateCommissionDetail } from '@/lib/admin/affiliate-service'
import { AdminPageHeader, formatDateTime, formatMoney } from '@/components/admin/ui'
import { AFFILIATE_COMMISSION_STATUS_LABELS, type AffiliateCommissionStatus } from '@/lib/affiliate/status-labels'
import { AffiliateCommissionActions } from '@/components/admin/affiliate-commission-actions'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Affiliate Commission — Unity Admin' }

/**
 * Step 11 Phase 7 -- admin overrides only: hold/release/void/retry/
 * mark-paid/adjust. No direct edit path exists anywhere for the
 * original commission_amount/rate/affiliate/customer/merchant/listing/
 * payment reference (Part G).
 */
export default async function AdminAffiliateCommissionDetailPage({ params }: PageProps) {
  const { id: commissionId } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminAffiliateCommissionDetail(admin, commissionId)
  if (!detail) notFound()

  const { commission, history, adjustments, payment, affiliateName, merchantName, listingTitle } = detail
  const c = commission as unknown as {
    id: string
    status: AffiliateCommissionStatus
    transaction_type: string
    eligible_base: number
    commission_rate: number
    commission_amount: number
    currency: string
    order_id: string | null
    booking_id: string | null
    created_at: string
    approved_at: string | null
    payout_provider: string | null
    payout_provider_reference: string | null
    payout_confirmed_at: string | null
    hold_reason: string | null
    void_reason: string | null
  }
  const p = payment as unknown as { status: string; provider: string | null; captured_at: string | null } | null

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/affiliate-commissions" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to commissions
      </Link>

      <AdminPageHeader eyebrow="Marketplace" title={`Commission — ${listingTitle ?? 'Listing'}`} badge={AFFILIATE_COMMISSION_STATUS_LABELS[c.status]?.label ?? c.status} />

      <div className="max-w-3xl space-y-8">
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Commission</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Affiliate</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{affiliateName ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Merchant</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{merchantName ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Listing</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{listingTitle ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Transaction type</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{c.transaction_type}</dd>
            <dt className="text-[#9B8B85]">Transaction</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">
              {c.order_id ? (
                <Link href={`/admin/orders/${c.order_id}`} className="hover:underline">View order</Link>
              ) : c.booking_id ? (
                <Link href={`/admin/bookings/${c.booking_id}`} className="hover:underline">View booking</Link>
              ) : '—'}
            </dd>
            <dt className="text-[#9B8B85]">Created</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(c.created_at)}</dd>
            {c.approved_at && (
              <>
                <dt className="text-[#9B8B85]">Approved</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(c.approved_at)}</dd>
              </>
            )}
            {c.hold_reason && (
              <>
                <dt className="text-[#9B8B85]">Hold reason</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{c.hold_reason}</dd>
              </>
            )}
            {c.void_reason && (
              <>
                <dt className="text-[#9B8B85]">Void reason</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{c.void_reason}</dd>
              </>
            )}
          </dl>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Calculation snapshot</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Eligible base</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatMoney(c.eligible_base, c.currency)}</dd>
            <dt className="text-[#9B8B85]">Rate</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{c.commission_rate}%</dd>
            <dt className="text-[#9B8B85]">Commission amount</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold">{formatMoney(c.commission_amount, c.currency)}</dd>
            <dt className="text-[#9B8B85]">Payment status</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{p?.status ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Payout provider</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{c.payout_provider ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Payout reference</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{c.payout_provider_reference ?? '—'}</dd>
          </dl>
          <p className="text-xs text-[#9B8B85] mt-2">
            This snapshot is immutable — corrections are recorded as an append-only adjustment below, never an edit to these values.
          </p>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Admin actions</h2>
          <AffiliateCommissionActions commissionId={c.id} status={c.status} />
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Adjustments ({adjustments.length})</h2>
          {adjustments.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No adjustments recorded.</p>
          ) : (
            <ul className="space-y-2">
              {adjustments.map((a) => {
                const row = a as unknown as { id: string; amount: number; reason: string; created_at: string }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatMoney(row.amount, c.currency)} — {row.reason}</span>
                    <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(row.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Immutable history</h2>
          {history.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No history recorded.</p>
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
      </div>
    </div>
  )
}
